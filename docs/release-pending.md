# Cierre de implementaciones — pendiente de publicación

El usuario cierra el alcance con las implementaciones actuales, sin nuevas funciones.

Publicado: descarga de fotografías propias (versión Cloudflare 91f545e2-23ef-47d4-9aa4-046ca60c2589), además de administración, invitaciones y recuperación de identidad anteriores.

Pendiente de desplegar: alias, muro ampliado, selector de grupos y envíos múltiples, cámara vertical con disparador superpuesto, pantalla completa, instalación PWA y navegación PHOTOWN que conserva grupo/captura.

La migración 0002_participant_alias.sql ya se aplicó correctamente tanto en local como en producción. Es aditiva y compatible con la versión publicada.

Pruebas: 19 de servidor superadas. Los nueve recorridos de navegador se comprobaron; los casos corregidos se repitieron individualmente. El último cambio de navegación de PHOTOWN tiene sintaxis válida y pruebas añadidas, pero su ejecución fue bloqueada por la revisión automática al agotarse el uso de la cuenta. No se debe afirmar que ese último recorrido pasó.

Para completar cuando vuelva a estar disponible la ejecución autorizada:

1. Ejecutar los recorridos de navegador `group destinations` y `portrait camera` (incluyen mantener grupo/captura al pulsar PHOTOWN).
2. Publicar con Wrangler y comprobar HTTPS, manifiesto, iconos y módulos servidos.
3. Subir el commit local a origin/main. No volver a crear recursos, cambiar DNS ni rotar secretos.

Pruebas físicas de instalación/cámara iPhone y Android siguen pendientes. UI general y alternancia selfie/trasera quedan para el siguiente sprint.
