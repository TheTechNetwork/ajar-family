# apple/parent-app — Parent iOS app (later-phase placeholder)

Not implemented yet. The primary parent/admin experience. Swift/SwiftUI. See
`docs/ARCHITECTURE.md §7`.

Responsibilities (Phase 3): login (Sign in with Apple / passkey / email + MFA);
family, children, devices, policies. **Requests** tab is the fastest surface —
pending requests shown immediately, APNs push ("Jane requested a YouTube video"),
and **actionable notification approve/deny without opening the app**
(`UNNotificationAction` with `.authenticationRequired`; high-stakes approvals
foreground + biometric). Approval in as few taps as possible, with a **scope**
choice (this request / exact URL / this video / channel / domain / device / child
/ whole family) defaulting to the **narrowest** useful permission, plus a
**duration** (15m / 30m / 1h / until end of day / once / always). Every decision
records the deciding parent. Tabs: Home, Requests, Children, Devices, Policies,
Settings.
