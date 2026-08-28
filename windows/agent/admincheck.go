//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// consoleUserIsAdmin reports whether the interactive (console) user is a member
// of the local Administrators group. Per ADR-006 the child must be a STANDARD
// account; an admin child can undo everything, so the service logs a loud
// warning (and the parent app should surface it). LocalSystem holds SeTcbName,
// which WTSQueryUserToken requires.
func consoleUserIsAdmin() (isAdmin bool, userName string, err error) {
	sessionID := windows.WTSGetActiveConsoleSessionId()
	if sessionID == 0xFFFFFFFF {
		return false, "", fmt.Errorf("no active console session")
	}
	var token windows.Token
	if err = windows.WTSQueryUserToken(sessionID, &token); err != nil {
		return false, "", fmt.Errorf("WTSQueryUserToken: %w", err)
	}
	defer token.Close()

	if u, e := token.GetTokenUser(); e == nil {
		if acc, dom, _, e2 := u.User.Sid.LookupAccount(""); e2 == nil {
			userName = dom + `\` + acc
		}
	}

	adminSid, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false, userName, fmt.Errorf("CreateWellKnownSid: %w", err)
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return false, userName, fmt.Errorf("GetTokenGroups: %w", err)
	}
	for _, g := range groups.AllGroups() {
		if g.Sid.Equals(adminSid) {
			return true, userName, nil
		}
	}
	return false, userName, nil
}
