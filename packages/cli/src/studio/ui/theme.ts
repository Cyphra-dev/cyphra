// Runs before the first paint: apply the saved theme (light / dark) to avoid a flash.
try {
  const t = localStorage.getItem("cyphra-studio-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  // storage blocked: follow the system theme
}
