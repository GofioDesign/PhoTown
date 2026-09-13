let promptEvent;
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
addEventListener('beforeinstallprompt', event => { event.preventDefault(); promptEvent = event; });
addEventListener('appinstalled', () => { promptEvent = null; document.querySelectorAll('[data-install]').forEach(button => button.hidden = true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
export function setupInstall(root) {
  for (const button of root.querySelectorAll('[data-install]')) {
    button.hidden = Boolean(installed());
    button.onclick = async () => {
      if (promptEvent) {
        const event = promptEvent; promptEvent = null;
        try { await event.prompt(); await event.userChoice; } catch { showHelp(button); }
      } else showHelp(button);
    };
  }
}
function showHelp(previous) {
  const dialog = document.createElement('dialog'); dialog.setAttribute('aria-labelledby', 'install-title');
  dialog.innerHTML = '<h2 id="install-title">Instalar PhoTown</h2><p>En iPhone o iPad: abre PhoTown en Safari, pulsa Compartir y elige «Añadir a pantalla de inicio».</p><p>En Android: abre el menú de Chrome y elige «Instalar aplicación» o «Añadir a pantalla de inicio», cuando esté disponible.</p><p>Abre después PhoTown desde su icono. Si te pide la invitación, vuelve a entrar con ella.</p><form method="dialog"><button autofocus>Cerrar instrucciones</button></form>';
  dialog.addEventListener('close', () => { dialog.remove(); previous.focus(); }, { once: true }); document.body.append(dialog); dialog.showModal();
}
