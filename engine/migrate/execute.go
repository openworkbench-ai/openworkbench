package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"pocketknife/materialize"
	"pocketknife/schema"
	"pocketknife/store"
)

// Execute applies a classified changeset to the store within a single migration
// transaction (see store.RunMigration). oldApp and newApp are the validated
// manifests on each side; newApp is the authority for the resulting schema.
//
// Renames touch no SQL — the physical column is the field's stable id, unchanged.
// Adds and drops use native ADD COLUMN / DROP COLUMN; type, nullability, enum, and
// reference changes use the SQLite table-rebuild pattern. The whole changeset is
// one transaction: any failure leaves the database unchanged, and the apply flow
// additionally restores a file snapshot for destructive runs.
//
// The same transaction also records newApp's schema fingerprint
// (store.WriteAppliedFingerprintTx), so the fingerprint that gates boot-time
// loading (registry.Load) only ever moves forward atomically with the schema
// change that earned it — never a moment before or after. A pure-rename
// changeset skips this too (see allNoSQL below): a rename never changes the
// fingerprint's value (schema.Fingerprint excludes Name), so there is
// nothing to move forward.
func Execute(ctx context.Context, st *store.Store, oldApp, newApp *schema.App, cs *Changeset) error {
	// A changeset of only renames touches no physical identifier (the column is
	// the unchanged stable id), so it runs literally zero SQL — no transaction is
	// even opened.
	if cs.IsEmpty() || allNoSQL(cs) {
		return nil
	}
	return st.RunMigration(ctx, func(tx *sql.Tx) error {
		if err := applyChangeset(tx, oldApp, newApp, cs); err != nil {
			return err
		}
		return store.WriteAppliedFingerprintTx(tx, schema.Fingerprint(newApp))
	})
}

// allNoSQL reports whether every operation is a pure rename. With id-keyed
// storage, a rename is a manifest/registry change only.
func allNoSQL(cs *Changeset) bool {
	for _, op := range cs.Ops {
		if op.Kind != OpRenameEntity && op.Kind != OpRenameField {
			return false
		}
	}
	return true
}

func applyChangeset(tx *sql.Tx, oldApp, newApp *schema.App, cs *Changeset) error {
	byEntity := map[string][]Operation{}
	added := map[string]bool{}
	dropped := map[string]bool{}
	for _, op := range cs.Ops {
		byEntity[op.EntityID] = append(byEntity[op.EntityID], op)
		switch op.Kind {
		case OpAddEntity:
			added[op.EntityID] = true
		case OpDropEntity:
			dropped[op.EntityID] = true
		}
	}

	// 1. Create added entities (in new-manifest order so this is deterministic).
	for _, ent := range newApp.Entities {
		if added[ent.ID] {
			if err := createEntity(tx, newApp, ent); err != nil {
				return err
			}
		}
	}

	// 2. Apply field-level changes to surviving entities.
	for _, ent := range newApp.Entities {
		if added[ent.ID] {
			continue
		}
		ops := byEntity[ent.ID]
		if len(ops) == 0 {
			continue
		}
		oldEnt := oldApp.EntityByID(ent.ID)
		if needsRebuild(ops) {
			if err := rebuildEntity(tx, newApp, oldEnt, ent, ops); err != nil {
				return err
			}
		} else if err := applyNativeOps(tx, newApp, ent, ops); err != nil {
			return err
		}
	}

	// 3. Drop removed entities last.
	for _, ent := range oldApp.Entities {
		if dropped[ent.ID] {
			if _, err := tx.Exec("DROP TABLE " + ent.ID + ";"); err != nil {
				return fmt.Errorf("drop entity %s: %w", ent.ID, err)
			}
		}
	}
	return nil
}

// needsRebuild reports whether an entity's operations require a full table
// rebuild rather than native ALTERs. Type, nullability, enum, and reference
// changes alter the column's baked-in definition (CHECK / NOT NULL / FK), which
// SQLite can only change by rebuilding. A new required field with no default also
// needs the rebuild path, since ADD COLUMN cannot add a NOT NULL column without a
// default.
func needsRebuild(ops []Operation) bool {
	for _, op := range ops {
		switch op.Kind {
		case OpChangeType, OpChangeRequired, OpChangeEnum, OpChangeReference:
			return true
		case OpAddField:
			if op.AfterField.Required && !op.AfterField.HasDefault {
				return true
			}
		}
	}
	return false
}

func createEntity(tx *sql.Tx, app *schema.App, ent *schema.Entity) error {
	create, indexes, err := materialize.TableDDL(app, ent, ent.ID, true)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(create); err != nil {
		return fmt.Errorf("create entity %s: %w", ent.ID, err)
	}
	for _, idx := range indexes {
		if _, err := tx.Exec(idx); err != nil {
			return fmt.Errorf("create index for %s: %w", ent.ID, err)
		}
	}
	return nil
}

// applyNativeOps handles the rebuild-free changes: adds, drops, uniqueness, and
// renames (which are no-ops at the SQL layer because the physical column is the
// stable id).
func applyNativeOps(tx *sql.Tx, app *schema.App, ent *schema.Entity, ops []Operation) error {
	for _, op := range ops {
		switch op.Kind {
		case OpRenameEntity, OpRenameField:
			// No SQL: the physical identifier is the unchanged stable id.

		case OpAddField:
			def, err := materialize.AddColumnDDL(app, ent, op.AfterField)
			if err != nil {
				return err
			}
			// Existing rows need a value for the new column. A field with a
			// declared default backfills them via a DEFAULT clause — which is also
			// what makes adding a NOT NULL column to a populated table legal in
			// SQLite. (Required fields without a default take the rebuild path,
			// which requires a backfill witness.)
			if op.AfterField.HasDefault {
				def += " DEFAULT " + sqlLiteral(op.AfterField.Default, op.AfterField.Type)
			}
			if _, err := tx.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s;", ent.ID, def)); err != nil {
				return fmt.Errorf("add field %s: %w", op.FieldID, err)
			}
			if op.AfterField.Unique {
				if err := createUniqueIndex(tx, ent, op.AfterField); err != nil {
					return err
				}
			}

		case OpDropField:
			if _, err := tx.Exec(fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s;", ent.ID, op.FieldID)); err != nil {
				return fmt.Errorf("drop field %s: %w", op.FieldID, err)
			}

		case OpChangeUnique:
			if op.AfterField.Unique {
				if err := createUniqueIndex(tx, ent, op.AfterField); err != nil {
					return err
				}
			} else if _, err := tx.Exec("DROP INDEX " + materialize.UniqueIndexName(ent, op.AfterField) + ";"); err != nil {
				return fmt.Errorf("drop unique index for %s: %w", op.FieldID, err)
			}

		default:
			return fmt.Errorf("operation %s on %s.%s is not a native op", op.Kind, ent.ID, op.FieldID)
		}
	}
	return nil
}

func createUniqueIndex(tx *sql.Tx, ent *schema.Entity, f *schema.Field) error {
	stmt := fmt.Sprintf("CREATE UNIQUE INDEX IF NOT EXISTS %s ON %s(%s);",
		materialize.UniqueIndexName(ent, f), ent.ID, f.ID)
	if _, err := tx.Exec(stmt); err != nil {
		return fmt.Errorf("create unique index for %s: %w", f.ID, err)
	}
	return nil
}

// rebuildEntity applies the SQLite table-rebuild ("12-step ALTER") to bring an
// entity to its new schema: create a new table at the target shape under a
// temporary name, copy every row through the per-field select expressions
// (applying witness coercions), drop the old table, rename the new one into place,
// and recreate its unique indexes. The surrounding store.RunMigration disables
// foreign keys for the rebuild and runs foreign_key_check before commit.
func rebuildEntity(tx *sql.Tx, newApp *schema.App, oldEnt, newEnt *schema.Entity, ops []Operation) error {
	witnessOf := witnessByField(ops)

	// Enforce CoerceFail guards before transforming anything.
	if err := enforceCoerceFail(tx, oldEnt, newEnt, witnessOf); err != nil {
		return err
	}

	tmp := "mig_" + newEnt.ID
	create, _, err := materialize.TableDDL(newApp, newEnt, tmp, false)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(create); err != nil {
		return fmt.Errorf("rebuild create %s: %w", newEnt.ID, err)
	}

	// Build the INSERT … SELECT that copies data into the new shape.
	destCols := []string{"id", "created_at", "updated_at"}
	srcExprs := []string{"id", "created_at", "updated_at"}
	for _, nf := range newEnt.Fields {
		expr, err := selectExpr(oldEnt, nf, witnessOf[nf.ID])
		if err != nil {
			return err
		}
		destCols = append(destCols, nf.ID)
		srcExprs = append(srcExprs, expr)
	}
	insert := fmt.Sprintf("INSERT INTO %s (%s)\n  SELECT %s FROM %s;",
		tmp, strings.Join(destCols, ", "), strings.Join(srcExprs, ", "), newEnt.ID)
	if _, err := tx.Exec(insert); err != nil {
		return fmt.Errorf("rebuild copy %s: %w", newEnt.ID, err)
	}

	if _, err := tx.Exec("DROP TABLE " + newEnt.ID + ";"); err != nil {
		return fmt.Errorf("rebuild drop old %s: %w", newEnt.ID, err)
	}
	if _, err := tx.Exec(fmt.Sprintf("ALTER TABLE %s RENAME TO %s;", tmp, newEnt.ID)); err != nil {
		return fmt.Errorf("rebuild rename %s: %w", newEnt.ID, err)
	}

	// Recreate unique indexes at the final table name.
	_, indexes, err := materialize.TableDDL(newApp, newEnt, newEnt.ID, false)
	if err != nil {
		return err
	}
	for _, idx := range indexes {
		if _, err := tx.Exec(idx); err != nil {
			return fmt.Errorf("rebuild index %s: %w", newEnt.ID, err)
		}
	}
	return nil
}

// selectExpr returns the SQL expression that produces newField's value in the
// rebuilt table, reading from the old table. A missing witness for a change that
// requires one is a hard error: the destructive op refuses to run.
func selectExpr(oldEnt *schema.Entity, nf *schema.Field, w *Witness) (string, error) {
	of := oldEnt.FieldByID(nf.ID)

	// Added field: NULL, a default, or a backfill witness for required-no-default.
	if of == nil {
		if nf.Required && !nf.HasDefault {
			if w == nil || w.Kind != WitnessBackfill {
				return "", fmt.Errorf("field %s: new required field needs a backfill witness", nf.ID)
			}
			return sqlLiteral(w.Backfill, nf.Type), nil
		}
		if nf.HasDefault {
			return sqlLiteral(nf.Default, nf.Type), nil
		}
		return "NULL", nil
	}

	// Same type: copy, possibly with an enum remap and/or a null backfill.
	if of.Type == nf.Type {
		expr := nf.ID
		if nf.Type == schema.TypeEnum && w != nil && w.Kind == WitnessRemap {
			expr = remapExpr(nf.ID, w)
		}
		if nf.Required && !of.Required {
			if w == nil || w.Kind != WitnessBackfill {
				return "", fmt.Errorf("field %s: nullable->not-null requires a backfill witness", nf.ID)
			}
			expr = fmt.Sprintf("COALESCE(%s, %s)", expr, sqlLiteral(w.Backfill, nf.Type))
		}
		return expr, nil
	}

	// Widening preserves all values via column affinity; no witness needed.
	if isWidening(of.Type, nf.Type) {
		return nf.ID, nil
	}

	// Narrowing requires a coercion witness.
	if w == nil || w.Kind != WitnessCoerce {
		return "", fmt.Errorf("field %s: narrowing %s->%s requires a coercion witness", nf.ID, of.Type, nf.Type)
	}
	return coerceExpr(nf.ID, nf.Type, w.Coerce)
}

// enforceCoerceFail rejects the migration if a CoerceFail witness would lose
// information on any existing row.
func enforceCoerceFail(tx *sql.Tx, oldEnt, newEnt *schema.Entity, witnessOf map[string]*Witness) error {
	for _, nf := range newEnt.Fields {
		of := oldEnt.FieldByID(nf.ID)
		if of == nil || of.Type == nf.Type {
			continue
		}
		w := witnessOf[nf.ID]
		if w == nil || w.Kind != WitnessCoerce || w.Coerce != CoerceFail {
			continue
		}
		var n int
		q := fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s;", oldEnt.ID, lossGuard(nf.ID, nf.Type))
		if err := tx.QueryRow(q).Scan(&n); err != nil {
			return fmt.Errorf("coerce-fail guard for %s: %w", nf.ID, err)
		}
		if n > 0 {
			return fmt.Errorf("field %s: %d row(s) would lose information narrowing %s->%s with coerce=fail", nf.ID, n, of.Type, nf.Type)
		}
	}
	return nil
}

// witnessByField indexes the witnesses present on an entity's operations by field
// id. One witness per field is supported.
func witnessByField(ops []Operation) map[string]*Witness {
	m := map[string]*Witness{}
	for _, op := range ops {
		if op.Witness != nil && op.FieldID != "" {
			m[op.FieldID] = op.Witness
		}
	}
	return m
}
