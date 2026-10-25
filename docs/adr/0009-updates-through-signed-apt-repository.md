---
status: accepted
---

# Updates come through a signed apt repository, and AgentBar stays offline

Until now, a user learns about a new AgentBar only by visiting the GitHub
release page, then downloads the `.deb` and installs it by hand. The package
is unsigned; a published SHA-256 is the only integrity check, and it comes from
the same place as the file. Users asked for "Update available" and a one-click
update.

An in-app check would mean AgentBar contacting the network. The README
promises "No network access, ever. Nothing is sent anywhere", and ADR 0003
makes "no daemon, no database, no network" a product promise. A daily request
to GitHub would also show every user's IP address and version to a third
party.

## Decision

New versions reach users through a **signed apt repository**, and AgentBar
itself makes no network calls.

- Users add AgentBar's repository once: its signing key, plus a deb822
  sources entry with `Signed-By`. From then on, Ubuntu's Software Updater
  and `apt upgrade` find new versions and verify them against that key
  before installing them with the user's admin password. Checking, trust,
  and installing are apt's job, done the way it does for every other
  package.
- There is no in-app update check and no "Update available" button. The
  task for one (an in-app check of GitHub's releases API) is dropped.
- After apt installs a new version, the logout prompt from #52 tells the
  user to log out to finish the upgrade. This needs no network: it compares
  the running extension with the installed files.
- The repository is signed with a key the maintainer creates and keeps. It
  is never stored in CI or in this repository. Only the public key is
  published.

The repository's hosting, layout, and tooling are decided when it is built
(its own issue). The constraints:

- It must serve plain files over HTTPS.
- It must not need the private key anywhere but the maintainer's machine.
- It must leave room for the project website on GitHub Pages.

## Considered options

- **In-app check of GitHub releases, once a day.** Rejected: it breaks the
  no-network promise, exposes users to a third party by default, and still
  needs a safe install path. Downloading a `.deb` and installing it as root
  from the extension would be worse than apt in every way.
- **Both: apt repository plus an optional in-app check.** Rejected for now:
  the most work, for a notice Software Updater already gives.
- **Defer.** Rejected: users already asked for updates, and the repository
  also fixes the "unsigned package" limitation.

## Consequences

- The README keeps "No network access, ever" for AgentBar. The install guide
  gains the one-time repository step, and says plainly that apt, not
  AgentBar, then checks the repository during its normal updates.
- The "package is unsigned" known limitation goes away once the repository
  exists. Manual `.deb` downloads with a checksum stay available.
- Every release adds a step: publish the signed package to the repository.
- Losing or leaking the signing key is now a real risk. The key needs an
  offline backup, an expiry date, and a documented rotation plan before the
  first signed release.
