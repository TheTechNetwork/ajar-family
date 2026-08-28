//go:build windows

// Family Filter Windows service (PoC C production path).
//
// Responsibilities: apply the HKLM browser policies that force-install the
// enforcement extension and close anti-bypass gaps, re-apply on a watchdog tick,
// and warn if the child account is an administrator (ADR-006). No TLS
// interception, no stealth/rootkit techniques — documented OS mechanisms only.
//
// Subcommands: install | uninstall | run | apply | status | version
// Started by the SCM it runs as a service; run `apply` interactively (elevated)
// to test policy writes without installing.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName = "FamilyFilterAgent"
	displayName = "Family Filter Agent"
	description = "Applies parental-control browser policies and monitors for tampering. github.com/00o-sh/contentfilter"
	version     = "0.1.0-alpha"
)

func main() {
	// When the SCM launches us there are no CLI args and we're in service context.
	if isService, err := svc.IsWindowsService(); err == nil && isService {
		runService()
		return
	}
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "install":
		must(install())
	case "uninstall":
		must(uninstall())
	case "apply":
		cfg := loadConfig()
		applyAll(cfg, stdoutLog)
		reportAdminChild(stdoutLog)
	case "status":
		must(status())
	case "run":
		runService()
	case "version":
		fmt.Println(serviceName, version)
	default:
		fmt.Printf(`Family Filter Agent %s
usage: %s <command>
  install     install + start the service (run elevated)
  uninstall   stop + remove the service and its policies
  apply       apply browser policies once now (test; run elevated)
  status      print service + policy status
  version     print version
`, version, filepath.Base(os.Args[0]))
	}
}

// ---- service execution ----

type service struct{ elog *eventlog.Log }

func runService() {
	elog, err := eventlog.Open(serviceName)
	if err != nil {
		return
	}
	defer elog.Close()
	_ = svc.Run(serviceName, &service{elog: elog})
}

func (s *service) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	cfg := loadConfig()
	log := func(format string, a ...any) { _ = s.elog.Info(1, fmt.Sprintf(format, a...)) }
	applyAll(cfg, log)
	reportAdminChild(log)

	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	ticker := time.NewTicker(time.Duration(cfg.ReapplyMinutes) * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			applyAll(cfg, log)
			reportAdminChild(log)
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				return false, 0
			}
		}
	}
}

func reportAdminChild(log logf) {
	admin, user, err := consoleUserIsAdmin()
	if err != nil {
		return // no interactive user (e.g. at the login screen) — nothing to warn about
	}
	if admin {
		log("WARNING: interactive user %s is a LOCAL ADMINISTRATOR — protections are bypassable (ADR-006). The child account must be a standard user.", user)
	}
}

// ---- install / uninstall / status ----

func install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("service %s already installed", serviceName)
	}
	s, err := m.CreateService(serviceName, exe, mgr.Config{
		DisplayName:  displayName,
		Description:  description,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	})
	if err != nil {
		return err
	}
	defer s.Close()
	// Auto-restart on crash OR non-zero exit / kill (the flag makes TerminateProcess count).
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 86400); err != nil {
		return err
	}
	if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Info|eventlog.Warning|eventlog.Error); err != nil {
		// non-fatal: service still runs, just no dedicated event source
		fmt.Println("warning: could not install event source:", err)
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("created but failed to start: %w", err)
	}
	fmt.Printf("installed and started %s (auto-start, auto-restart)\n", serviceName)
	return nil
}

func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("not installed: %w", err)
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	time.Sleep(time.Second)
	if err := s.Delete(); err != nil {
		return err
	}
	_ = eventlog.Remove(serviceName)
	removePolicies(stdoutLog)
	fmt.Printf("removed %s\n", serviceName)
	return nil
}

func status() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		fmt.Println("service: NOT INSTALLED")
		return nil
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	states := map[svc.State]string{svc.Stopped: "STOPPED", svc.Running: "RUNNING", svc.StartPending: "START_PENDING", svc.StopPending: "STOP_PENDING"}
	fmt.Printf("service: %s\n", states[st.State])
	admin, user, err := consoleUserIsAdmin()
	if err == nil {
		fmt.Printf("console user: %s (admin=%v)\n", user, admin)
	}
	return nil
}

func stdoutLog(format string, a ...any) { fmt.Printf(format+"\n", a...) }

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
