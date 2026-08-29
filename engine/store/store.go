// Package store owns each app's SQLite database: one data.db file per app, no
// shared database ever. It exposes a generic, schema-driven CRUD/query surface.
// Every value crosses the SQL boundary through a bound parameter; identifiers
// (table/column names) come only from validated, SQL-safe schema names.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"

	"pocketknife/schema"
)

// MinSQLiteVersion is the lowest SQLite version the runtime supports. The
// migration engine depends on ALTER TABLE ... ADD/DROP COLUMN, which require
// 3.35.0. It is asserted at boot (Open), so an underpowered build fails fast.
const MinSQLiteVersion = "3.35.0"

// Sentinel errors the API layer maps to HTTP status codes.
var (
	// ErrUnique is returned when a write violates a UNIQUE constraint (409).
	ErrUnique = errors.New("unique constraint violation")
	// ErrForeignKey is returned when a write violates a FOREIGN KEY
	// constraint, e.g. deleting a row referenced under ON DELETE RESTRICT (409).
	ErrForeignKey = errors.New("foreign key constraint violation")
)

// Store is one app's database handle.
type Store struct {
	db   *sql.DB
	path string
}

// Open opens (creating if needed) the SQLite database at path with
// foreign-key enforcement enabled on every connection. A single underlying
// connection keeps writes serialised, which is the simplest correct choice for
// SQLite and avoids "database is locked" under concurrent requests.
//
// WAL journal mode is enabled so the migration engine can take a consistent
// snapshot by checkpointing the log into the main file before copying it (see
// Checkpoint). On a clean Close, SQLite checkpoints and removes the -wal/-shm
// sidecars, so the at-rest data.db is always complete.
func Open(path string) (*Store, error) {
	dsn := path + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping %s: %w", path, err)
	}
	if err := assertSQLiteVersion(db); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(schemaMetaDDL); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema metadata table: %w", err)
	}
	return &Store{db: db, path: path}, nil
}

// assertSQLiteVersion fails if the linked SQLite is older than MinSQLiteVersion.
// The migration engine's ADD/DROP COLUMN support requires 3.35.0.
func assertSQLiteVersion(db *sql.DB) error {
	var v string
	if err := db.QueryRow("SELECT sqlite_version();").Scan(&v); err != nil {
		return fmt.Errorf("read sqlite version: %w", err)
	}
	if compareVersions(v, MinSQLiteVersion) < 0 {
		return fmt.Errorf("sqlite %s is below the required minimum %s (ADD/DROP COLUMN need 3.35.0)", v, MinSQLiteVersion)
	}
	return nil
}

// compareVersions compares two dotted version strings numerically, returning -1,
// 0, or 1. Missing components are treated as zero.
func compareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			fmt.Sscanf(pa[i], "%d", &x)
		}
		if i < len(pb) {
			fmt.Sscanf(pb[i], "%d", &y)
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Path returns the database file path (used for isolation assertions/tests).
func (s *Store) Path() string { return s.path }

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// Checkpoint flushes the write-ahead log into the main database file and
// truncates the log, so a byte-for-byte copy of the database file is a complete,
// consistent snapshot. It is a harmless no-op when the database is not in WAL
// mode. The migration engine calls this immediately before snapshotting.
func (s *Store) Checkpoint() error {
	// wal_checkpoint returns a result row (busy, log, checkpointed); Query and
	// discard it. An error here means the snapshot would be inconsistent, so it
	// must propagate.
	rows, err := s.db.Query("PRAGMA wal_checkpoint(TRUNCATE);")
	if err != nil {
		return fmt.Errorf("wal_checkpoint: %w", err)
	}
	return rows.Close()
}

// ApplyDDL runs schema DDL statements in order. Statements are idempotent
// (CREATE TABLE/INDEX IF NOT EXISTS), so this is safe to run on every boot.
//
// Seam: a future migration engine would compare the stored manifest against the
// new one here and emit ALTER statements; v1 only ever creates.
func (s *Store) ApplyDDL(stmts []string) error {
	for _, stmt := range stmts {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("apply DDL %q: %w", firstLine(stmt), err)
		}
	}
	return nil
}

// VerifySchema reports a descriptive error if the on-disk database does not
// exactly match what materialize.Statements would produce for app: every
// entity must have a table, and that table's physical column set (the
// platform columns plus one column per declared field, keyed by the field's
// stable id — the same convention materialize.TableDDL and migrate/execute.go
// both use) must match exactly, with nothing missing and nothing extra.
//
// This is detection only: it never alters the database. It exists because
// ApplyDDL's CREATE TABLE IF NOT EXISTS is a true no-op against a table that
// already exists with a different shape — if a manifest changes without a
// migration ever running against its data.db, boot would otherwise serve a
// schema the database no longer actually has. Call this after ApplyDDL, not
// instead of it.
func (s *Store) VerifySchema(app *schema.App) error {
	var problems []string
	for _, ent := range app.Entities {
		actual, err := s.tableColumns(ent.ID)
		if err != nil {
			return fmt.Errorf("verify schema: read columns for %s: %w", ent.ID, err)
		}
		if actual == nil {
			problems = append(problems, fmt.Sprintf("entity %q (%s): table is missing", ent.Name, ent.ID))
			continue
		}
		missing, extra := diffColumnSets(expectedPhysicalColumns(ent), actual)
		if len(missing) > 0 || len(extra) > 0 {
			problems = append(problems, fmt.Sprintf(
				"entity %q (%s): column mismatch (missing=%v extra=%v)",
				ent.Name, ent.ID, missing, extra))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("manifest does not match the on-disk database:\n  %s", strings.Join(problems, "\n  "))
	}
	return nil
}

// tableColumns returns tableName's physical column names, or nil if the table
// does not exist (SQLite's PRAGMA table_info returns zero rows, not an error,
// for an unknown table — a real table always has at least the "id" column).
func (s *Store) tableColumns(tableName string) ([]string, error) {
	rows, err := s.db.Query(fmt.Sprintf("PRAGMA table_info(%s);", tableName))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []string
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt any
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return cols, nil
}

// expectedPhysicalColumns is the physical column set materialize.Statements
// produces for ent.
func expectedPhysicalColumns(ent *schema.Entity) []string {
	cols := make([]string, 0, len(ent.Fields)+3)
	cols = append(cols, "id", "created_at", "updated_at")
	for _, f := range ent.Fields {
		cols = append(cols, f.ID)
	}
	return cols
}

// diffColumnSets compares two column-name sets order-independently.
func diffColumnSets(expected, actual []string) (missing, extra []string) {
	expSet := make(map[string]bool, len(expected))
	for _, c := range expected {
		expSet[c] = true
	}
	actSet := make(map[string]bool, len(actual))
	for _, c := range actual {
		actSet[c] = true
	}
	for _, c := range expected {
		if !actSet[c] {
			missing = append(missing, c)
		}
	}
	for _, c := range actual {
		if !expSet[c] {
			extra = append(extra, c)
		}
	}
	return missing, extra
}

// schemaMetaTable holds the single row recording the fingerprint of the
// schema last successfully applied to this database (see
// schema.Fingerprint). Its name leads with an underscore, which no entity
// id can ever match (entity/field stable ids are constrained to
// ^[a-z][a-z0-9_]*$), so it can never collide with an app-declared table.
const schemaMetaTable = "_schema_meta"

const schemaMetaDDL = `CREATE TABLE IF NOT EXISTS ` + schemaMetaTable + ` (
	id INTEGER PRIMARY KEY CHECK (id = 0),
	fingerprint TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`

const upsertSchemaMetaSQL = `INSERT INTO ` + schemaMetaTable + ` (id, fingerprint, updated_at) VALUES (0, ?, ?)
	ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at;`

// AppliedFingerprint returns the fingerprint of the schema last successfully
// applied to this database, or ok=false if none has ever been recorded — a
// brand-new database before its first materialize, or a database created
// before this mechanism existed (a "legacy" app).
func (s *Store) AppliedFingerprint() (fingerprint string, ok bool, err error) {
	err = s.db.QueryRow("SELECT fingerprint FROM "+schemaMetaTable+" WHERE id = 0;").Scan(&fingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read applied schema fingerprint: %w", err)
	}
	return fingerprint, true, nil
}

// SetAppliedFingerprint records fingerprint as the schema currently applied
// to this database. Callers must only call this once they know the schema
// operation that produced this fingerprint actually succeeded — see
// WriteAppliedFingerprintTx for recording it atomically with the migration
// that produced it.
func (s *Store) SetAppliedFingerprint(fingerprint string) error {
	if _, err := s.db.Exec(upsertSchemaMetaSQL, fingerprint, NowUTC()); err != nil {
		return fmt.Errorf("set applied schema fingerprint: %w", err)
	}
	return nil
}

// WriteAppliedFingerprintTx records fingerprint using an already-open
// transaction, so a migration's schema change and its fingerprint update
// commit — or roll back — together. Used by migrate/execute.go.
func WriteAppliedFingerprintTx(tx *sql.Tx, fingerprint string) error {
	if _, err := tx.Exec(upsertSchemaMetaSQL, fingerprint, NowUTC()); err != nil {
		return fmt.Errorf("set applied schema fingerprint: %w", err)
	}
	return nil
}

// RunMigration executes fn within the SQLite scaffold documented for changing a
// table's schema by rebuild. Foreign-key enforcement is disabled on a single
// pinned connection (it cannot be toggled inside a transaction), a transaction is
// begun, fn runs its DDL/DML, and before commit a foreign_key_check verifies that
// nothing was orphaned. On any error the transaction rolls back and the database
// is left unchanged. Foreign keys are re-enabled before the connection is
// returned, whatever the outcome.
//
// This gives schema-change atomicity at the SQLite level; the migration engine
// layers a file snapshot on top for byte-exact recovery across the whole flow.
func (s *Store) RunMigration(ctx context.Context, fn func(*sql.Tx) error) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("pin connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys=OFF;"); err != nil {
		return fmt.Errorf("disable foreign keys: %w", err)
	}
	defer conn.ExecContext(ctx, "PRAGMA foreign_keys=ON;")

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration tx: %w", err)
	}

	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}

	if err := foreignKeyCheck(ctx, tx); err != nil {
		_ = tx.Rollback()
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}
	return nil
}

// foreignKeyCheck fails if the database has any foreign-key violation. Used as the
// integrity gate just before a migration commits.
func foreignKeyCheck(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check;")
	if err != nil {
		return fmt.Errorf("foreign_key_check: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		return fmt.Errorf("%w: migration would leave foreign-key violations", ErrForeignKey)
	}
	return rows.Err()
}

// dbi is the subset of *sql.DB / *sql.Tx that the row CRUD helpers below need.
// Both types satisfy it unchanged, so every helper works identically whether
// it runs against the store's ambient connection or a caller-managed
// transaction (see Tx) — the only difference is which one gets passed in.
type dbi interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Tx is a transaction-scoped view of one Store's row CRUD surface (the same
// methods as Store itself: Insert/GetByID/Exists/List/Update/Delete), letting
// several operations commit — or roll back — together. This is what gives a
// manifest-declared tool's step sequence (see the tools package) atomicity:
// every step in one call runs against the same Tx, and a failure at any step
// rolls back everything the earlier steps in that call did.
type Tx struct {
	tx *sql.Tx
}

// BeginTx starts a transaction on the store's connection.
func (s *Store) BeginTx(ctx context.Context) (*Tx, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	return &Tx{tx: tx}, nil
}

// Commit commits the transaction.
func (t *Tx) Commit() error { return t.tx.Commit() }

// Rollback rolls back the transaction. Calling it after a successful Commit
// is a no-op error callers are expected to ignore (the standard sql.Tx
// contract), matching the defer-rollback-then-commit pattern used elsewhere
// in this codebase (see migrate/'s use of store.RunMigration).
func (t *Tx) Rollback() error { return t.tx.Rollback() }

func (t *Tx) Insert(ent *schema.Entity, values map[string]any) (map[string]any, error) {
	return insertWith(t.tx, ent, values)
}
func (t *Tx) GetByID(ent *schema.Entity, id string) (map[string]any, error) {
	return getByIDWith(t.tx, ent, id)
}
func (t *Tx) Exists(ent *schema.Entity, id string) (bool, error) {
	return existsWith(t.tx, ent, id)
}
func (t *Tx) List(ent *schema.Entity, q ListQuery) ([]map[string]any, int, error) {
	return listWith(t.tx, ent, q)
}
func (t *Tx) Update(ent *schema.Entity, id string, values map[string]any) (map[string]any, error) {
	return updateWith(t.tx, ent, id, values)
}
func (t *Tx) Delete(ent *schema.Entity, id string) (bool, error) {
	return deleteWith(t.tx, ent, id)
}

// Insert writes a new row. values holds JSON-typed Go values keyed by field
// name; the platform columns (id, created_at, updated_at) are supplied by the
// caller via reserved keys. It returns the stored row, decoded back to JSON
// types.
func (s *Store) Insert(ent *schema.Entity, values map[string]any) (map[string]any, error) {
	return insertWith(s.db, ent, values)
}

func insertWith(db dbi, ent *schema.Entity, values map[string]any) (map[string]any, error) {
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]any, 0, len(values))

	for col, v := range values {
		cols = append(cols, physCol(ent, col))
		placeholders = append(placeholders, "?")
		args = append(args, encode(ent, col, v))
	}

	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s);",
		ent.ID, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	if _, err := db.Exec(query, args...); err != nil {
		return nil, classify(err)
	}
	return getByIDWith(db, ent, values["id"].(string))
}

// GetByID returns a single row by primary key, or (nil, nil) if absent.
func (s *Store) GetByID(ent *schema.Entity, id string) (map[string]any, error) {
	return getByIDWith(s.db, ent, id)
}

func getByIDWith(db dbi, ent *schema.Entity, id string) (map[string]any, error) {
	cols := selectColumns(ent)
	query := fmt.Sprintf("SELECT %s FROM %s WHERE id = ? LIMIT 1;",
		strings.Join(physColumns(ent, cols), ", "), ent.ID)
	rows, err := db.Query(query, id)
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanRow(ent, cols, rows)
}

// Exists reports whether a row with the given id exists. Used to validate
// reference targets before a write.
func (s *Store) Exists(ent *schema.Entity, id string) (bool, error) {
	return existsWith(s.db, ent, id)
}

func existsWith(db dbi, ent *schema.Entity, id string) (bool, error) {
	var one int
	err := db.QueryRow(fmt.Sprintf("SELECT 1 FROM %s WHERE id = ? LIMIT 1;", ent.ID), id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, classify(err)
	}
	return true, nil
}

// Filter is one AND-combined list filter.
type Filter struct {
	Column   string // validated field/platform column name
	Operator string // SQL operator (=, !=, >, >=, <, <=, LIKE)
	Value    any    // JSON-typed, coerced to the field type
}

// Sort is one ORDER BY term.
type Sort struct {
	Column string
	Desc   bool
}

// ListQuery describes a list request.
type ListQuery struct {
	Filters []Filter
	Sorts   []Sort
	Limit   int
	Offset  int
}

// List returns matching rows plus the total count of rows matching the filters
// (ignoring limit/offset).
func (s *Store) List(ent *schema.Entity, q ListQuery) ([]map[string]any, int, error) {
	return listWith(s.db, ent, q)
}

func listWith(db dbi, ent *schema.Entity, q ListQuery) ([]map[string]any, int, error) {
	where, args := buildWhere(ent, q.Filters)

	var total int
	countQ := fmt.Sprintf("SELECT COUNT(*) FROM %s%s;", ent.ID, where)
	if err := db.QueryRow(countQ, args...).Scan(&total); err != nil {
		return nil, 0, classify(err)
	}

	cols := selectColumns(ent)
	var sb strings.Builder
	fmt.Fprintf(&sb, "SELECT %s FROM %s%s", strings.Join(physColumns(ent, cols), ", "), ent.ID, where)
	sb.WriteString(buildOrderBy(ent, q.Sorts))
	sb.WriteString(" LIMIT ? OFFSET ?")
	listArgs := append(append([]any{}, args...), q.Limit, q.Offset)

	rows, err := db.Query(sb.String()+";", listArgs...)
	if err != nil {
		return nil, 0, classify(err)
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		row, err := scanRow(ent, cols, rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, row)
	}
	return out, total, rows.Err()
}

// Update applies a partial change. values holds only the columns to change
// (including updated_at). It returns the updated row, or (nil, nil) if the row
// does not exist.
func (s *Store) Update(ent *schema.Entity, id string, values map[string]any) (map[string]any, error) {
	return updateWith(s.db, ent, id, values)
}

func updateWith(db dbi, ent *schema.Entity, id string, values map[string]any) (map[string]any, error) {
	if len(values) == 0 {
		return getByIDWith(db, ent, id)
	}
	sets := make([]string, 0, len(values))
	args := make([]any, 0, len(values)+1)
	for col, v := range values {
		sets = append(sets, physCol(ent, col)+" = ?")
		args = append(args, encode(ent, col, v))
	}
	args = append(args, id)

	query := fmt.Sprintf("UPDATE %s SET %s WHERE id = ?;", ent.ID, strings.Join(sets, ", "))
	res, err := db.Exec(query, args...)
	if err != nil {
		return nil, classify(err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Either the row is absent, or no values changed. Disambiguate by read.
		return getByIDWith(db, ent, id)
	}
	return getByIDWith(db, ent, id)
}

// Delete removes a row, reporting whether one was deleted.
func (s *Store) Delete(ent *schema.Entity, id string) (bool, error) {
	return deleteWith(s.db, ent, id)
}

func deleteWith(db dbi, ent *schema.Entity, id string) (bool, error) {
	res, err := db.Exec(fmt.Sprintf("DELETE FROM %s WHERE id = ?;", ent.ID), id)
	if err != nil {
		return false, classify(err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// --- helpers ---

// Physical identifiers (table and column names) are keyed by stable id, never by
// the mutable display name. The store's public surface stays logical: callers
// pass and receive maps keyed by field name, and physCol is the single point
// that resolves a logical name to its physical column. Because the physical
// column is the field's id, a rename (which changes only the name) maps to the
// same column and therefore moves no data — this is the property the migration
// engine relies on.
//
// physCol maps a logical column key to its physical SQLite column. The platform
// columns (id, created_at, updated_at) are physical as-is; a declared field
// resolves through its name to its stable id.
func physCol(ent *schema.Entity, logical string) string {
	switch logical {
	case "id", "created_at", "updated_at":
		return logical
	}
	if f := ent.Field(logical); f != nil {
		return f.ID
	}
	// Unreachable for validated input: callers only pass known columns.
	return logical
}

// physColumns maps a slice of logical column keys to physical columns, preserving
// order.
func physColumns(ent *schema.Entity, logical []string) []string {
	phys := make([]string, len(logical))
	for i, c := range logical {
		phys[i] = physCol(ent, c)
	}
	return phys
}

func selectColumns(ent *schema.Entity) []string {
	cols := make([]string, 0, len(ent.Fields)+3)
	cols = append(cols, "id")
	for _, f := range ent.Fields {
		cols = append(cols, f.Name)
	}
	cols = append(cols, "created_at", "updated_at")
	return cols
}

func buildWhere(ent *schema.Entity, filters []Filter) (string, []any) {
	if len(filters) == 0 {
		return "", nil
	}
	clauses := make([]string, 0, len(filters))
	args := make([]any, 0, len(filters))
	for _, f := range filters {
		clauses = append(clauses, fmt.Sprintf("%s %s ?", physCol(ent, f.Column), f.Operator))
		args = append(args, encode(ent, f.Column, f.Value))
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

// buildOrderBy renders the ORDER BY clause. The platform primary key `id` is
// always appended as a final tiebreaker so that list and pagination output is
// deterministic even when the user's sort keys tie (e.g. rows created within the
// same millisecond sorted by created_at).
func buildOrderBy(ent *schema.Entity, sorts []Sort) string {
	terms := make([]string, 0, len(sorts)+1)
	for _, s := range sorts {
		dir := "ASC"
		if s.Desc {
			dir = "DESC"
		}
		terms = append(terms, physCol(ent, s.Column)+" "+dir)
	}
	terms = append(terms, "id ASC")
	return " ORDER BY " + strings.Join(terms, ", ")
}

// encode converts a JSON-typed value into its SQLite storage representation.
// The only translation needed is boolean → 0/1; everything else binds directly.
func encode(ent *schema.Entity, col string, v any) any {
	if v == nil {
		return nil
	}
	if f := ent.Field(col); f != nil && f.Type == schema.TypeBoolean {
		if b, ok := v.(bool); ok {
			if b {
				return int64(1)
			}
			return int64(0)
		}
	}
	return v
}

// scanRow reads one row into a JSON-ready map, decoding storage types back to
// JSON types (notably INTEGER 0/1 → boolean) and []byte → string.
func scanRow(ent *schema.Entity, cols []string, rows *sql.Rows) (map[string]any, error) {
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	row := make(map[string]any, len(cols))
	for i, col := range cols {
		row[col] = decode(ent, col, vals[i])
	}
	return row, nil
}

func decode(ent *schema.Entity, col string, v any) any {
	if v == nil {
		return nil
	}
	if b, ok := v.([]byte); ok {
		v = string(b)
	}
	if f := ent.Field(col); f != nil && f.Type == schema.TypeBoolean {
		switch n := v.(type) {
		case int64:
			return n != 0
		case float64:
			return n != 0
		}
	}
	return v
}

// classify maps SQLite constraint errors to sentinel errors the API recognises.
func classify(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "UNIQUE constraint failed"):
		return fmt.Errorf("%w: %s", ErrUnique, msg)
	case strings.Contains(msg, "FOREIGN KEY constraint failed"):
		return fmt.Errorf("%w: %s", ErrForeignKey, msg)
	default:
		return err
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
