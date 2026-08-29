package migrate

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"pocketknife/store"
)

// SnapshotDirName is the per-app subdirectory that holds migration snapshots.
const SnapshotDirName = ".snapshots"

// DefaultRetention is how many snapshots are kept per app by default. Older
// snapshots beyond this are pruned after a successful migration.
const DefaultRetention = 5

// snapshotPrefix / snapshotSuffix bracket the timestamp in a snapshot filename.
const (
	snapshotPrefix = "data-"
	snapshotSuffix = ".db"
)

// Snapshot checkpoints the store's write-ahead log into the main database file
// and copies that file byte-for-byte into dir, returning the snapshot's path.
// Taking the snapshot after a checkpoint is what makes a plain file copy a
// consistent point-in-time image even under WAL.
func Snapshot(st *store.Store, dir string) (string, error) {
	if err := st.Checkpoint(); err != nil {
		return "", fmt.Errorf("snapshot checkpoint: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("snapshot mkdir: %w", err)
	}
	// Nanosecond UTC timestamp keeps filenames chronologically sortable and
	// collision-free in practice.
	name := snapshotPrefix + time.Now().UTC().Format("20060102T150405.000000000Z") + snapshotSuffix
	dst := filepath.Join(dir, name)
	if err := copyFile(st.Path(), dst); err != nil {
		return "", fmt.Errorf("snapshot copy: %w", err)
	}
	return dst, nil
}

// Restore overwrites the database at dbPath with the snapshot at snapPath,
// byte-for-byte, and removes any stale -wal/-shm sidecars so post-snapshot log
// state cannot reappear. The database must be closed before calling Restore.
func Restore(snapPath, dbPath string) error {
	if err := copyFile(snapPath, dbPath); err != nil {
		return fmt.Errorf("restore copy: %w", err)
	}
	for _, sfx := range []string{"-wal", "-shm"} {
		if err := os.Remove(dbPath + sfx); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("restore clear %s: %w", sfx, err)
		}
	}
	return nil
}

// Prune keeps the most recent keep snapshots in dir and deletes the rest. A
// non-positive keep deletes nothing (retention disabled).
func Prune(dir string, keep int) error {
	if keep <= 0 {
		return nil
	}
	snaps, err := listSnapshots(dir)
	if err != nil {
		return err
	}
	if len(snaps) <= keep {
		return nil
	}
	for _, old := range snaps[:len(snaps)-keep] {
		if err := os.Remove(filepath.Join(dir, old)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("prune %s: %w", old, err)
		}
	}
	return nil
}

// listSnapshots returns snapshot filenames in dir, sorted oldest-first (their
// timestamped names sort chronologically).
func listSnapshots(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && len(n) > len(snapshotPrefix)+len(snapshotSuffix) &&
			n[:len(snapshotPrefix)] == snapshotPrefix && filepath.Ext(n) == ".db" {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names, nil
}

// copyFile copies src to dst byte-for-byte and fsyncs the result so a snapshot
// survives a crash.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
