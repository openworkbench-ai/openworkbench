// Package pythonpackages installs portable Python wheels into an app bundle.
// Installation copies files only: package code never executes on the Go host.
package pythonpackages

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Wheel struct {
	Name string `json:"name"`
	Data []byte `json:"data"`
}

const maxExpandedBytes = 128 << 20

var requirementName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*`)
var separators = regexp.MustCompile(`[-_.]+`)

func normalized(name string) string { return separators.ReplaceAllString(strings.ToLower(name), "-") }

func wheelDistribution(name string) (string, error) {
	if filepath.Base(name) != name || strings.ContainsAny(name, "/\\") || !strings.HasSuffix(name, ".whl") {
		return "", fmt.Errorf("invalid wheel filename %q", name)
	}
	parts := strings.Split(strings.TrimSuffix(name, ".whl"), "-")
	if len(parts) < 5 || parts[len(parts)-1] != "any" || parts[len(parts)-2] != "none" {
		return "", fmt.Errorf("package %q requires a native extension; a compatible Wasm build is required", name)
	}
	compatible := false
	for _, tag := range strings.Split(parts[len(parts)-3], ".") {
		if tag == "cp313" || strings.HasPrefix(tag, "py3") {
			compatible = true
		}
	}
	if !compatible {
		return "", fmt.Errorf("wheel %q does not support Python 3.13", name)
	}
	return normalized(parts[0]), nil
}

func installedPath(name string) (string, error) {
	name = strings.TrimSuffix(name, "/")
	if !fs.ValidPath(name) || strings.Contains(name, "\\") {
		return "", fmt.Errorf("invalid wheel member path %q", name)
	}
	parts := strings.Split(name, "/")
	if strings.HasSuffix(parts[0], ".data") && len(parts) > 1 {
		if parts[1] == "purelib" && len(parts) > 2 {
			return strings.Join(parts[2:], "/"), nil
		}
		return "", nil // executable entrypoints/headers aren't importable modules
	}
	return name, nil
}

// Validate checks tags, metadata, declared direct dependencies, paths and size
// limits before any files are written. Transitive wheels are included by pip.
func Validate(wheels []Wheel, requirements []string) error {
	if len(requirements) == 0 && len(wheels) > 0 {
		return fmt.Errorf("Python wheels require manifest python.packages")
	}
	distributions := map[string]bool{}
	var expanded uint64
	for _, wheel := range wheels {
		distribution, err := wheelDistribution(wheel.Name)
		if err != nil {
			return err
		}
		if distributions[distribution] {
			return fmt.Errorf("duplicate Python distribution %q", distribution)
		}
		distributions[distribution] = true
		reader, err := zip.NewReader(bytes.NewReader(wheel.Data), int64(len(wheel.Data)))
		if err != nil {
			return fmt.Errorf("invalid wheel %q: %w", wheel.Name, err)
		}
		pure := false
		for _, member := range reader.File {
			if member.UncompressedSize64 > maxExpandedBytes || expanded > maxExpandedBytes-member.UncompressedSize64 {
				return fmt.Errorf("Python packages exceed the 128 MiB expanded limit")
			}
			expanded += member.UncompressedSize64
			if _, err := installedPath(member.Name); err != nil {
				return err
			}
			if !member.FileInfo().IsDir() && !member.Mode().IsRegular() {
				return fmt.Errorf("wheel members must be regular files")
			}
			if strings.HasSuffix(member.Name, ".so") || strings.HasSuffix(member.Name, ".pyd") || strings.HasSuffix(member.Name, ".dll") {
				return fmt.Errorf("native extension in %q needs a Wasm build", wheel.Name)
			}
			if strings.HasSuffix(member.Name, ".dist-info/WHEEL") {
				f, err := member.Open()
				if err != nil {
					return err
				}
				metadata, err := io.ReadAll(io.LimitReader(f, 64<<10))
				f.Close()
				if err != nil {
					return err
				}
				for _, line := range strings.Split(string(metadata), "\n") {
					if strings.EqualFold(strings.TrimSpace(line), "Root-Is-Purelib: true") {
						pure = true
					}
				}
			}
		}
		if !pure {
			return fmt.Errorf("wheel %q is not a portable pure-Python package", wheel.Name)
		}
	}
	for _, req := range requirements {
		name := normalized(requirementName.FindString(req))
		if name == "" || !distributions[name] {
			return fmt.Errorf("missing resolved Python package for %q", req)
		}
	}
	return nil
}

// Install extracts wheels into a fresh staging directory and records the exact
// wheel hashes. All caller paths are validated; symlinks and collisions fail.
func Install(appDir string, wheels []Wheel, requirements []string) error {
	if err := Validate(wheels, requirements); err != nil {
		return err
	}
	if len(wheels) == 0 {
		return nil
	}
	packagesDir := filepath.Join(appDir, "python", "site-packages")
	if err := os.MkdirAll(packagesDir, 0755); err != nil {
		return err
	}
	written := map[string]bool{}
	lock := make([]map[string]string, 0, len(wheels))
	for _, wheel := range wheels {
		reader, _ := zip.NewReader(bytes.NewReader(wheel.Data), int64(len(wheel.Data)))
		for _, member := range reader.File {
			path, err := installedPath(member.Name)
			if err != nil {
				return err
			}
			if path == "" || member.FileInfo().IsDir() {
				continue
			}
			if written[path] {
				return fmt.Errorf("Python package file collision at %q", path)
			}
			written[path] = true
			target := filepath.Join(packagesDir, filepath.FromSlash(path))
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			in, err := member.Open()
			if err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
			if err != nil {
				in.Close()
				return err
			}
			_, copyErr := io.Copy(out, io.LimitReader(in, int64(member.UncompressedSize64)+1))
			closeErr := out.Close()
			in.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
		lock = append(lock, map[string]string{"wheel": wheel.Name, "sha256": fmt.Sprintf("%x", sha256.Sum256(wheel.Data))})
	}
	data, err := json.MarshalIndent(lock, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(appDir, "python", "wheels.lock.json"), data, 0644)
}
