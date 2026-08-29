// Package registry holds the in-memory map of served apps and the boot loader
// that derives it from disk. The manifest files are the source of truth; the
// registry is a derived cache rebuilt from them on every boot. Deleting the
// registry loses nothing — a restart re-derives it and all data persists in the
// per-app data.db files.
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
	mu   sync.RWMutex
	apps map[string]*RegisteredApp
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{apps: map[string]*RegisteredApp{}}
}

// Register adds or replaces an app.
func (r *Registry) Register(app *RegisteredApp) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.apps[app.Schema.ID] = app
}

// Unregister removes an app so it is no longer served. It does not close the
// app's store -- the caller, which opened it, is responsible for that.
func (r *Registry) Unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.apps, id)
}

// App returns the registered app for an ID.
func (r *Registry) App(id string) (*RegisteredApp, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.apps[id]
	return a, ok
}

// Apps returns all registered apps, sorted by ID for stable output.
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

// Close releases every app's database handle.
func (r *Registry) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var firstErr error
	for _, a := range r.apps {
		if err := a.Store.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
