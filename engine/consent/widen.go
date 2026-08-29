package consent

import "pocketknife/schema"

// Delta is the set of capabilities a new manifest version's union grants that
// the prior version's union did not. It only ever contains additions: a
// capability the new version dropped is not a re-consent event, because it
// can only narrow what the app could already do.
type Delta struct {
	NewData    []DataGrant
	NewNetwork []string
	NewModel   bool
}

// RequiresReconsent reports whether this delta contains any widening at all —
// the signal a future shell (Phase 6) uses to decide whether an app update
// must be re-approved before it runs.
func (d *Delta) RequiresReconsent() bool {
	return d != nil && (len(d.NewData) > 0 || len(d.NewNetwork) > 0 || d.NewModel)
}

// Widened compares the derived capability union of oldApp against newApp and
// returns exactly what the new version added. Like Diff in the migrate
// package, it is a pure function of its two inputs: it trusts no caller hint
// about what changed, only the manifests themselves.
func Widened(oldApp, newApp *schema.App) *Delta {
	before := Union(oldApp)
	after := Union(newApp)

	beforeData := map[DataGrant]bool{}
	for _, g := range before.Data {
		beforeData[g] = true
	}
	beforeNetwork := map[string]bool{}
	for _, d := range before.Network {
		beforeNetwork[d] = true
	}

	d := &Delta{NewModel: after.Model && !before.Model}
	for _, g := range after.Data {
		if !beforeData[g] {
			d.NewData = append(d.NewData, g)
		}
	}
	for _, dom := range after.Network {
		if !beforeNetwork[dom] {
			d.NewNetwork = append(d.NewNetwork, dom)
		}
	}
	return d
}
