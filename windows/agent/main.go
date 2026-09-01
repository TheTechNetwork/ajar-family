//go:build windows

// Ajar Windows service (PoC C production path).
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
	serviceName = "AjarFamilyAgent"
	displayName = "Ajar Family Agent"
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
		fmt.Printf(`Ajar Family Agent %s
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
	// A MISSING EVENT SOURCE MUST NOT MEAN A MISSING SERVICE.
	//
	// This used to `return` when eventlog.Open failed — so svc.Run was never
	// called, the process exited without reporting to the SCM (error 1053), the
	// recovery actions restarted it, and it failed identically forever. With no
	// event source there was also, by construction, nowhere to say why. And
	// install() treats a failed InstallAsEventCreate as non-fatal, printing a
	// warning to a console nobody sees, so this was reachable by design.
	//
	// Now the log is best-effort and the service runs regardless.
	elog, err := eventlog.Open(serviceName)
	if err != nil {
		elog = nil
	} else {
		defer elog.Close()
	}
	// svc.Run's error is reported rather than discarded: if the SCM handshake
	// fails there is no other trace of it anywhere.
	if err := svc.Run(serviceName, &service{elog: elog}); err != nil {
		fmt.Fprintln(os.Stderr, "service failed to start:", err)
	}
}

func (s *service) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	cfg := loadConfig()
	// `s.elog` may be nil — see runService. A service that cannot log is still a
	// service that should filter.
	log := func(format string, a ...any) {
		if s.elog == nil {
			return
		}
		_ = s.elog.Info(1, fmt.Sprintf(format, a...))
	}
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
		// NOT SILENCE. Every failure of WTSQueryUserToken / GetTokenGroups /
		// CreateWellKnownSid used to be treated as "no interactive user", so
		// ADR-006's entire premise — the child must not be an administrator —
		// degraded to saying nothing at all whenever the check itself broke.
		// "Nobody is logged in" and "we could not tell" are different facts.
		log("could not check whether the console user is an administrator: %v — "+
			"ADR-006 requires a STANDARD user account for the child", err)
		return
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
	// Auto-restart on crash OR non-zero exit / kill.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 86400); err != nil {
		return err
	}
	// THE FLAG THE COMMENT ABOVE USED TO CLAIM. Without it, Windows applies the
	// recovery actions only when the service CRASHES — a clean non-zero exit, and
	// a TerminateProcess from an admin, are not "failures" and the service simply
	// stays stopped. The old comment said "the flag makes TerminateProcess count"
	// while nothing ever set it, so the restart guarantee this service's whole
	// anti-tamper posture leans on did not cover the case it was written for.
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		// Not fatal: crash-restart still works, and refusing to install over this
		// would leave a machine with no service at all.
		fmt.Println("warning: could not enable restart-on-non-crash-exit:", err)
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

	// WHAT IS ACTUALLY IN THE REGISTRY. `status` advertised "print service +
	// policy status" and read nothing but the SCM, so it printed RUNNING on a box
	// where every policy write had been failing since install. The one command an
	// operator runs to check now checks the thing that does the work.
	fmt.Println("policies:")
	for _, line := range policyStatus() {
		fmt.Println(line)
	}

	cfg := loadConfig()
	if cfg.ChromeExtensionID == "" && cfg.EdgeExtensionID == "" {
		fmt.Printf("config:  NO EXTENSION ID SET in %s — nothing is being enforced\n", configPath())
	}

	// A failure here is not "no interactive user": see admincheck.go.
	admin, user, err := consoleUserIsAdmin()
	switch {
	case err != nil:
		fmt.Printf("console user: could not be checked (%v) — cannot confirm the child is a standard user\n", err)
	case admin:
		fmt.Printf("console user: %s — LOCAL ADMINISTRATOR. Protections are bypassable (ADR-006).\n", user)
	default:
		fmt.Printf("console user: %s (standard user)\n", user)
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
