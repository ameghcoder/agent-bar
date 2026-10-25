// T905: whether AgentBar needs a logout to finish an upgrade. On Wayland,
// GNOME Shell loads extension code only at login, so after a package upgrade
// the running extension is older than its files on disk. Pure functions with
// no imports, so Node tests them directly (test/upgrade.test.mjs).

// The version in an installed metadata.json, or null when the text is
// missing or unreadable (for example while dpkg is replacing the file).
export function installedVersion(metadataText) {
    try {
        const version = JSON.parse(metadataText)?.['version-name'];
        return typeof version === 'string' && version !== '' ? version : null;
    } catch {
        return null;
    }
}

// Only a known installed version that differs from the running one asks for
// a logout; an unreadable file never does.
export function needsRelogin(runningVersion, metadataText) {
    const installed = installedVersion(metadataText);
    return typeof runningVersion === 'string' && installed !== null && installed !== runningVersion;
}
