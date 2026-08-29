// Package consent computes the capability surface an app's functions ask for,
// so a future shell (Phase 6) can render it before an app is allowed to run.
// Nothing here is authored: every value is derived purely from the manifest's
// declared function capabilities, exactly as migrate derives a changeset from
// two schema versions rather than trusting a caller's claim about what
// changed.
package consent

import (
	"sort"

	"pocketknife/schema"
)

// DataGrant is one entity+operation pair some function in the app has been
// granted.
type DataGrant struct {
	EntityID  string
	Operation schema.Operation
}

// Capabilities is the union of every function's declared capabilities in one
// app: the full set of host-interface power the app could exercise across all
// of its functions, collapsed and deduplicated.
type Capabilities struct {
	Data    []DataGrant
	Network []string
	Model   bool
}

// IsEmpty reports whether the app's functions declare no capabilities at all.
func (c *Capabilities) IsEmpty() bool {
	return c == nil || (len(c.Data) == 0 && len(c.Network) == 0 && !c.Model)
}

// Union computes the capability surface of every function declared in app. It
// is a pure function of the manifest: the same app always yields the same
// union, regardless of call order or any other input.
func Union(app *schema.App) *Capabilities {
	dataSet := map[DataGrant]bool{}
	domainSet := map[string]bool{}
	model := false

	for _, fn := range app.Functions {
		if fn.Capabilities == nil {
			continue
		}
		for _, ds := range fn.Capabilities.Data {
			for _, op := range ds.Operations {
				dataSet[DataGrant{EntityID: ds.Entity, Operation: op}] = true
			}
		}
		for _, d := range fn.Capabilities.Network {
			domainSet[d] = true
		}
		if fn.Capabilities.Model {
			model = true
		}
	}

	c := &Capabilities{Model: model}
	for g := range dataSet {
		c.Data = append(c.Data, g)
	}
	for d := range domainSet {
		c.Network = append(c.Network, d)
	}
	sort.Slice(c.Data, func(i, j int) bool {
		if c.Data[i].EntityID != c.Data[j].EntityID {
			return c.Data[i].EntityID < c.Data[j].EntityID
		}
		return c.Data[i].Operation < c.Data[j].Operation
	})
	sort.Strings(c.Network)
	return c
}
