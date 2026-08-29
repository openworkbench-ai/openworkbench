package domain

import (
	"pocketknife/schema"
	"pocketknife/store"
)

// RowStore is the storage boundary domain operations need: create/read/list/
// update/delete one entity's rows, plus the existence check a reference
// field's validation depends on. It is satisfied, unchanged, by *store.Store
// today — SQLite is an implementation of this boundary, not its definition.
// Callers needing store.Store's other responsibilities (opening a database,
// running a schema migration inside a transaction, checkpointing before a
// snapshot) are outside domain's scope; those stay in migrate/ and store/,
// which never touch row data and don't need this interface.
type RowStore interface {
	Insert(ent *schema.Entity, values map[string]any) (map[string]any, error)
	GetByID(ent *schema.Entity, id string) (map[string]any, error)
	Exists(ent *schema.Entity, id string) (bool, error)
	List(ent *schema.Entity, q store.ListQuery) ([]map[string]any, int, error)
	Update(ent *schema.Entity, id string, values map[string]any) (map[string]any, error)
	Delete(ent *schema.Entity, id string) (bool, error)
}
