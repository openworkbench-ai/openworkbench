// Package pocketknife exposes the canonical manifest JSON Schema as an embedded
// asset so the validator can compile it without depending on the working
// directory. The schema file at the repository root is the written contract;
// this embed keeps the running binary self-contained.
package pocketknife

import _ "embed"

// ManifestSchemaJSON is the canonical manifest JSON Schema (manifest.schema.json).
//
//go:embed manifest.schema.json
var ManifestSchemaJSON []byte
