// Package registry holds the in-memory map of served apps and the boot loader
// that derives it from disk. The manifest files are the source of truth; the
// registry is a derived cache rebuilt from them on every boot. Deleting the
// registry loses nothing — a restart re-derives it and all data persists in the
// per-app data.db files.
//
// Beyond boot, the registry also supports adding, removing, and toggling one
// app at a time without a restart -- the mechanism the admin API (see
// pocketknife/adminapi and pocketknife/lifecycle) builds on. An app lives in
// exactly one of two maps: apps (active -- App/Apps and therefore every
// request-serving package can see it) or inactive (loaded, database open,
// but invisible to App/Apps). Moving between them (Activate/Deactivate) never
// touches the store; only Register/Unregister/Close ever open or close one.
package registry

import (
	"sort"
	"sync"

	"pocketknife/schema"
	"pocketknife/store"
)

// RegisteredApp is a live app: its compiled schema plus the handle to its own
// database.
type RegisteredApp struct {
	Schema *schema.App
	Store  *store.Store
	Dir    string
}

// Registry is the hot path for requests: a concurrency-safe lookup from app ID
// to its compiled schema and store.
type Registry struct {
	mu       sync.RWMutex
	apps     map[string]*RegisteredApp // active: served by App/Apps
	inactive map[string]*RegisteredApp // loaded, store open, not served
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{apps: map[string]*RegisteredApp{}, inactive: map[string]*RegisteredApp{}}
}

// Register adds an app, or replaces one already registered (active or
// inactive) under the same schema ID -- always into the active set, since a
// caller reinstalling an app expects it to be servable again immediately.
// If this replaces an existing entry backed by a different store handle
// (e.g. reinstalling after a manifest edit reopened the database), the old
// handle is closed here so it's never leaked.
func (r *Registry) Register(app *RegisteredApp) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := app.Schema.ID
	if old, ok := r.apps[id]; ok && old.Store != app.Store {
		old.Store.Close()
	}
	if old, ok := r.inactive[id]; ok && old.Store != app.Store {
		old.Store.Close()
	}
	delete(r.inactive, id)
	r.apps[id] = app
}

// Unregister removes an app, active or inactive, so it is no longer served or
// resumable. It does not close the app's store -- the caller, which opened
// it, is responsible for that.
func (r *Registry) Unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.apps, id)
	delete(r.inactive, id)
}

// Deactivate moves an active app to the inactive set, so App/Apps stop
// seeing it, without closing its store -- Activate can bring it back
// without reopening the database. Reports false if id isn't active.
func (r *Registry) Deactivate(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	app, ok := r.apps[id]
	if !ok {
		return false
	}
	delete(r.apps, id)
	r.inactive[id] = app
	return true
}

// Activate moves an inactive app back to the active set. Reports false if id
// isn't inactive (either unknown, or already active).
func (r *Registry) Activate(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	app, ok := r.inactive[id]
	if !ok {
		return false
	}
	delete(r.inactive, id)
	r.apps[id] = app
	return true
}

// Status reports whether id is currently served ("active"), loaded but
// deactivated ("inactive"), or unknown to this registry (ok=false).
func (r *Registry) Status(id string) (status string, ok bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if _, found := r.apps[id]; found {
		return "active", true
	}
	if _, found := r.inactive[id]; found {
		return "inactive", true
	}
	return "", false
}

// App returns the registered, active app for an ID. An inactive app is not
// visible here -- this is the lookup every request-serving package uses, so
// deactivating an app is exactly what makes it stop being served.
func (r *Registry) App(id string) (*RegisteredApp, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.apps[id]
	return a, ok
}

// Apps returns all active apps, sorted by ID for stable output.
func (r *Registry) Apps() []*RegisteredApp {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*RegisteredApp, 0, len(r.apps))
	for _, a := range r.apps {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Schema.ID < out[j].Schema.ID })
	return out
}

// IDs returns the IDs of every app known to the registry, active or
// inactive, each paired with its Status, sorted by ID.
func (r *Registry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.apps)+len(r.inactive))
	for id := range r.apps {
		out = append(out, id)
	}
	for id := range r.inactive {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Close releases every app's database handle, active or inactive.
func (r *Registry) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var firstErr error
	for _, a := range r.apps {
		if err := a.Store.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	for _, a := range r.inactive {
		if err := a.Store.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
