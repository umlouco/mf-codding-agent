//go:build !windows

package playwright

import "errors"

// junction only exists on Windows; elsewhere a symlink is always available, so
// reaching this means the symlink itself failed and there is nothing to retry.
func junction(from, to string) error {
	return errors.New("symlink failed and no alternative exists on this platform")
}
