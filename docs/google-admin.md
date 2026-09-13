# Administración con Google

Panel: https://photown.gofiodesign.eu/admin

Dirección anterior disponible durante la transición: https://photown.photown.workers.dev/admin

Solo pueden administrar `gofiodesign@gmail.com` y `juanalbglz@gmail.com`. El servidor aplica esa lista en cada solicitud, después de verificar la identidad de Google. Google no se exige a los participantes.

## Google Auth Platform

En el proyecto de Google Cloud, usar un cliente OAuth de tipo **Aplicación web**.

- URI de redirección autorizada: `https://photown.gofiodesign.eu/api/admin/google/callback`
- Conservar también `https://photown.photown.workers.dev/api/admin/google/callback` mientras se use la dirección anterior.
- Origen de la aplicación: `https://photown.gofiodesign.eu`
- Si la audiencia sigue en modo de prueba, añadir las dos direcciones administradoras a los usuarios de prueba.
- El flujo solicita únicamente `openid email`; no accede a Drive, Gmail ni contactos.

`GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` están configurados como secretos del Worker. Nunca subir el archivo descargado de Google, credenciales, cookies o valores de secretos a GitHub. Para sustituir un valor usar `wrangler secret put` o el panel de secretos del Worker.

El backend verifica firma, emisor, audiencia, caducidad, nonce, email verificado y lista de administradores. El flujo usa state de un solo uso y PKCE. La sesión administrativa tiene una duración de ocho horas y está separada de la identidad de participante. El botón Cerrar sesión solo cierra la sesión administrativa de PhoTown.

## Funciones del panel

- Crear grupos independientes.
- Generar invitaciones nuevas de 8 caracteres, con letras mayúsculas y números, sin 0/O/1/I/L. Se aceptan también al escribirlas en minúsculas. Los códigos anteriores siguen funcionando hasta rotarlos.
- Copiar código o enlace `/enter?inv=CODIGO`. También se admite `/?inv=CODIGO`: rellena el código visible y basta pulsar Entrar. Se retira el parámetro de la barra de direcciones al cargar. El código se muestra una vez en administración y solo se conserva su hash.
- Abrir/cerrar grupos. Cerrar el grupo impide inmediatamente el acceso de sus participantes.
- Revisar fotografías, aprobarlas, ocultarlas o eliminarlas definitivamente.
- Asignar confianza o bloquear a un participante dentro de un grupo.

Los dos administradores tienen acceso a todos los grupos de esta instalación. No hay roles administrativos por grupo todavía. Las listas se orientan a grupos pequeños; la lista de participantes del panel muestra hasta 200 por grupo.

## Accesibilidad

La invitación se escribe como texto visible. El visor completo y el espacio libre de la cámara permiten disparar con un clic; los enlaces y controles mantienen su propia función. También hay un botón de Fotografiar con nombre accesible, texto visible y activación mediante teclado. No hay un atajo global que intercepte teclas mientras se escribe.

Las pantallas cambian el foco a su encabezado, los avisos se anuncian y el diálogo de borrado admite teclado/Escape. Se mantiene contraste alto, áreas táctiles amplias y compatibilidad con colores forzados. Las fotografías admiten una descripción textual opcional en Mis fotos para mejorar su interpretación con lectores de pantalla; sin descripción no se inventa el contenido visual.

Esto no certifica conformidad WCAG ni sustituye pruebas con personas con discapacidad, lectores de pantalla, ampliación, navegación por voz y dispositivos de apoyo. La fotografía en directo sigue siendo una actividad predominantemente visual; quedan por investigar ayudas de encuadre y orientación accesibles.

## Borrado y privacidad

El participante puede borrar sus fotos del grupo actual, incluso si están pendientes u ocultas. El servidor verifica propiedad y grupo. La retirada del muro es inmediata; el archivo de R2 se elimina antes de confirmar el éxito. Si R2 falla, queda inaccesible y se reintenta desde Mis fotos o mediante una tarea periódica.

Se conserva un registro mínimo de identificador/ruta, sin propietario, descripción ni hash de imagen, para impedir que un reenvío resucite el archivo y para retirar escrituras tardías. El borrado no puede retirar copias que otra persona ya haya visto/capturado ni alterar de inmediato las retenciones de recuperación del proveedor. No hay una papelera recuperable desde PhoTown.

Las fotografías del sprint 1 no tenían publisher y no se atribuyen automáticamente a ningún navegador. Cada nueva participación genera una identidad persistente con cookie HttpOnly; borrarla pierde el acceso a las fotos propias. No se recupera mediante Google ni correo del participante.

Las cookies pertenecen a cada dominio. Al cambiar desde workers.dev hay que entrar de nuevo con la invitación; las fotos hechas desde la dirección anterior siguen asociadas a la identidad de ese navegador en la dirección anterior. No se transfieren automáticamente entre dominios.
