// Shows the app and matter.js versions at the bottom of the sidebar
fetch("/api/version")
    .then(response => (response.ok ? response.json() : null))
    .then(versions => {
        const sidebar = document.querySelector(".sidebar");
        if (!versions || !sidebar) return;
        const parts = [];
        if (versions.app) parts.push(`v${versions.app}`);
        if (versions.matterJs) parts.push(`matter.js ${versions.matterJs}`);
        if (parts.length === 0) return;
        const version = document.createElement("p");
        version.className = "app-version";
        version.textContent = parts.join(" · ");
        sidebar.append(version);
    })
    .catch(() => {});
