package api_test

import (
	"net/url"
	"testing"
)

// listURL builds a properly URL-encoded list path for an entity from filter
// terms (field:op:value) and is the safe way to pass values containing spaces or
// LIKE wildcards.
func listURL(appEntity string, filters ...string) string {
	v := url.Values{}
	for _, f := range filters {
		v.Add("filter", f)
	}
	return "/apps/" + appEntity + "?" + v.Encode()
}

// TestQuerySevenOperators exercises every v1 filter operator end-to-end plus an
// AND-combined filter, against book_app's integer `rating` and text `title`.
// This pins the full v1 query surface as part of the Phase 1 gate.
func TestQuerySevenOperators(t *testing.T) {
	srv := bootManifest(t, "book_app", bookManifest)

	for i, rating := range []int{1, 2, 3, 4, 5} {
		title := string(rune('a' + i)) // a, b, c, d, e
		do(t, srv, "POST", "/apps/book_app/book",
			map[string]any{"title": title, "rating": rating}).wantStatus(t, 201)
	}

	total := func(filters ...string) int {
		r := do(t, srv, "GET", listURL("book_app/book", filters...), nil).wantStatus(t, 200)
		return int(r.body["total"].(float64))
	}

	cases := []struct {
		name    string
		filters []string
		want    int
	}{
		{"eq", []string{"rating:eq:3"}, 1},
		{"ne", []string{"rating:ne:3"}, 4},
		{"gt", []string{"rating:gt:3"}, 2},
		{"gte", []string{"rating:gte:3"}, 3},
		{"lt", []string{"rating:lt:3"}, 2},
		{"lte", []string{"rating:lte:3"}, 3},
		{"like", []string{"title:like:a"}, 1},
		{"and", []string{"rating:gte:2", "rating:lte:4"}, 3},
	}
	for _, c := range cases {
		if got := total(c.filters...); got != c.want {
			t.Errorf("%s (%v): total = %d, want %d", c.name, c.filters, got, c.want)
		}
	}
}

// TestLikeIsCaseInsensitive documents and pins the chosen LIKE semantics:
// SQLite's default ASCII case-insensitive matching. This is an intentional v1
// decision, asserted here rather than left incidental.
func TestLikeIsCaseInsensitive(t *testing.T) {
	srv := bootManifest(t, "book_app", bookManifest)

	do(t, srv, "POST", "/apps/book_app/book",
		map[string]any{"title": "The Go Programming Language"}).wantStatus(t, 201)

	matches := func(pattern string) int {
		r := do(t, srv, "GET", listURL("book_app/book", "title:like:"+pattern), nil).wantStatus(t, 200)
		return int(r.body["total"].(float64))
	}

	// Lowercase pattern matches the mixed-case title (ASCII case-insensitive).
	if got := matches("the go%"); got != 1 {
		t.Errorf("lowercase prefix like: total = %d, want 1 (LIKE should be case-insensitive)", got)
	}
	// Uppercase pattern likewise matches.
	if got := matches("%LANGUAGE"); got != 1 {
		t.Errorf("uppercase suffix like: total = %d, want 1", got)
	}
	// A non-matching substring returns nothing.
	if got := matches("%python%"); got != 0 {
		t.Errorf("non-matching like: total = %d, want 0", got)
	}
}

// fkManifest declares one parent with three children, one per onDelete action,
// so cascade / restrict / set_null can each be proven natively enforced.
const fkManifest = `{
  "app": { "id": "fk_app", "name": "FK App", "version": 1 },
  "entities": [
    { "id": "ent_parent", "name": "parent", "fields": [
      { "id": "fld_parent_label", "name": "label", "type": "text", "required": true }
    ]},
    { "id": "ent_casc", "name": "casc", "fields": [
      { "id": "fld_casc_name", "name": "name", "type": "text", "required": true },
      { "id": "fld_casc_ref", "name": "parent", "type": "reference", "target": "ent_parent", "onDelete": "cascade" }
    ]},
    { "id": "ent_rstr", "name": "rstr", "fields": [
      { "id": "fld_rstr_name", "name": "name", "type": "text", "required": true },
      { "id": "fld_rstr_ref", "name": "parent", "type": "reference", "target": "ent_parent", "onDelete": "restrict" }
    ]},
    { "id": "ent_snul", "name": "snul", "fields": [
      { "id": "fld_snul_name", "name": "name", "type": "text", "required": true },
      { "id": "fld_snul_ref", "name": "parent", "type": "reference", "target": "ent_parent", "onDelete": "set_null" }
    ]}
  ]
}`

// TestReferenceIntegrityIsNativelyEnforced proves all three onDelete actions are
// enforced by SQLite's foreign keys (not application logic): deleting a parent
// cascades to its cascade-children, is blocked by a restrict-child, and nulls a
// set_null child's reference.
func TestReferenceIntegrityIsNativelyEnforced(t *testing.T) {
	srv := bootManifest(t, "fk_app", fkManifest)

	mkParent := func() string {
		p := do(t, srv, "POST", "/apps/fk_app/parent", map[string]any{"label": "p"}).wantStatus(t, 201)
		return p.body["id"].(string)
	}
	mkChild := func(entity, parentID string) string {
		c := do(t, srv, "POST", "/apps/fk_app/"+entity,
			map[string]any{"name": "c", "parent": parentID}).wantStatus(t, 201)
		return c.body["id"].(string)
	}

	// cascade: deleting the parent removes the child.
	pCasc := mkParent()
	cCasc := mkChild("casc", pCasc)
	do(t, srv, "DELETE", "/apps/fk_app/parent/"+pCasc, nil).wantStatus(t, 204)
	do(t, srv, "GET", "/apps/fk_app/casc/"+cCasc, nil).wantStatus(t, 404)

	// restrict: deleting a referenced parent is blocked by the DB (409).
	pRstr := mkParent()
	mkChild("rstr", pRstr)
	do(t, srv, "DELETE", "/apps/fk_app/parent/"+pRstr, nil).wantStatus(t, 409)
	// The parent still exists because the delete was refused.
	do(t, srv, "GET", "/apps/fk_app/parent/"+pRstr, nil).wantStatus(t, 200)

	// set_null: deleting the parent nulls the child's reference, child survives.
	pSnul := mkParent()
	cSnul := mkChild("snul", pSnul)
	do(t, srv, "DELETE", "/apps/fk_app/parent/"+pSnul, nil).wantStatus(t, 204)
	got := do(t, srv, "GET", "/apps/fk_app/snul/"+cSnul, nil).wantStatus(t, 200)
	if got.body["parent"] != nil {
		t.Fatalf("set_null reference not nulled: %v", got.body["parent"])
	}
}
