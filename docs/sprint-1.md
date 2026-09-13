# Sprint 1: alcance y aceptación

## Recorrido implementado

`/ → /enter → /camera → /preview → POST /api/photos → R2 privado`

La entrada explica BN y observación. La cámara abre la trasera cuando está disponible, solicita vídeo sin micrófono y muestra BN desde el primer fotograma. El disparador solo se habilita al estar lista. Preview ofrece Repetir y Enviar. Repetir descarta la captura temporal. Enviar conserva captura y UUID si falla. Un envío confirmado libera la memoria y permite seguir fotografiando.

Se cierran las pistas de cámara al cambiar de pantalla, ocultar la pestaña o abandonar la página. Al regresar a Camera se reabre la cámara. Cargar `/preview` sin captura vuelve a Camera. Al perder la sesión se puede introducir la invitación sin perder la captura en memoria. Recargar o cerrar la página pierde esa captura; no hay cola offline ni almacenamiento local de fotografías.

## Decisiones de Sprint 0 adoptadas para desbloquear Camera

| Tema | Decisión de este sprint | Pendiente |
| --- | --- | --- |
| Arquitectura | JS sin framework, Worker con Static Assets y R2 | D1 al introducir publishers/photos |
| Entrada privada | Código aleatorio compartido, cookie temporal firmada | Identidad pseudónima independiente en Sprint 2 |
| Imagen | BN uniforme, WebP 0.88, lado mayor máximo 2560, 5 MiB | Comparación real móvil/proyector, posible normalización servidor |
| Privacidad | No datos civiles, cámara sin audio, R2 privado, sin EXIF/XMP/ICC | Retención acordada antes de Alpha |
| Publicación | Guardado técnico, sin estado público ni autor | NEW/MODERATED/TRUSTED/BLOCKED y pending/published/hidden |
| Semana | No se asigna ni se acepta desde cliente en Camera | Propuesta para Sprint 3: semana ISO, lunes, Atlantic/Canary; confirmar antes de implementar |

## Pruebas manuales pendientes antes de cerrar aceptación física

- [ ] iPhone/Safari con HTTPS: permiso inicial, denegación y recuperación desde ajustes.
- [ ] Android/Chrome con HTTPS: cámara trasera, permiso inicial y retorno desde otra aplicación.
- [ ] Confirmar visualmente que el directo ya es BN al abrir la cámara.
- [ ] Retrato y paisaje: imagen completa en directo y captura, sin estiramientos ni recortes.
- [ ] Imagen real con luz intensa, sombras profundas y detalle fino: comparar preview y captura, móvil y pantalla grande.
- [ ] Usar Repetir varias veces y comprobar que el indicador de cámara se apaga en Preview.
- [ ] Cortar red tras capturar, intentar envío, restaurar red y reintentar; comprobar un solo objeto en R2.
- [ ] Perder la respuesta después de guardar y reenviar: mismo objeto, confirmación correcta.
- [ ] Eliminar cookie con captura abierta: renovar acceso y enviar sin volver a fotografiar.
- [ ] Revisar permisos denegados, cámara ocupada, dispositivo sin cámara y WebP no soportado.
- [ ] Botones y foco con teclado; textos con lector de pantalla; zoom al 200 %.
- [ ] Inspeccionar archivo almacenado: WebP decodificable, BN, sin metadatos innecesarios.
- [ ] Verificar bucket privado, secretos configurados y ausencia de fotos en el repositorio.

Estas casillas no se consideran aprobadas por pasar pruebas sintéticas. El sprint entrega código comprobable, no la validación del ciclo semanal ni el Alpha.

## Más adelante: aviso de exposición

Petición del usuario: opción para señalar **en rojo**, sobre la vista de cámara en BN, las luces quemadas y las sombras sin detalle como ayuda para detectar exceso o carencia de iluminación.

Fuera del sprint 1. Antes de implementarla: acordar umbrales de luminancia, distinguir altas luces/sombras si es necesario y comprobar que la ayuda no domina la imagen. La superposición será informativa y opcional; nunca se incluirá en los píxeles de la fotografía ni modificará la conversión BN. La vista BN básica seguirá siendo obligatoria, esté activado o no ese aviso.
