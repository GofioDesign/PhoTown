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
- Recuperar fotografías tras perder una cookie: la persona entra de nuevo, copia «Mi identidad» en Personalización → Recuperar mi acceso y la comunica al administrador. En Gestionar grupo, el administrador contrasta la identidad anterior con las fotografías (muestran su identificador), selecciona el origen e introduce la nueva identidad. Ambas deben pertenecer al grupo. La confirmación reasigna las fotos pendientes/publicadas/ocultas conservando sus estados y descripciones; bloquea el origen y conserva los permisos propios del destino. No restaura fotos borradas ni transfiere envíos incompletos u otros grupos. El proceso es repetible sin duplicar imágenes; se modifica propiedad, no los archivos de R2.

Los dos administradores tienen acceso a todos los grupos de esta instalación. No hay roles administrativos por grupo todavía. Las listas se orientan a grupos pequeños; la lista de participantes del panel muestra hasta 200 por grupo.

## Accesibilidad

La invitación se escribe como texto visible. El visor completo y el espacio libre de la cámara permiten disparar con un clic; los enlaces y controles mantienen su propia función. También hay un botón de Fotografiar con nombre accesible y activación mediante teclado. No hay un atajo global que intercepte teclas mientras se escribe.

Las pantallas cambian el foco a su encabezado, los avisos se anuncian y el diálogo de borrado admite teclado/Escape. Se mantiene contraste alto, áreas táctiles amplias y compatibilidad con colores forzados. Las fotografías admiten una descripción textual opcional en Mis fotos para mejorar su interpretación con lectores de pantalla; sin descripción no se inventa el contenido visual.

Esto no certifica conformidad WCAG ni sustituye pruebas con personas con discapacidad, lectores de pantalla, ampliación, navegación por voz y dispositivos de apoyo. La fotografía en directo sigue siendo una actividad predominantemente visual; quedan por investigar ayudas de encuadre y orientación accesibles.

## Borrado y privacidad

El alias opcional se guarda por grupo, admite hasta 40 caracteres y puede retirarse dejándolo vacío. No es una identidad verificada ni un nombre único. El muro muestra el alias actual; tras recuperar una identidad, las fotos usan el alias del destino.

Cada envío a varios grupos crea una copia independiente. YO reúne todas las copias del propietario. Descargar o borrar actúa sobre las copias seleccionadas, y la confirmación identifica los grupos afectados. Cambiar de grupo no concede acceso a grupos nuevos, que siguen requiriendo invitación.

El participante puede borrar sus copias de todos sus grupos desde YO, incluso si están pendientes u ocultas. El servidor verifica la propiedad también al efectuar la retirada. La retirada del muro es inmediata; el archivo de R2 se elimina antes de confirmar el éxito. Si R2 falla, queda inaccesible y una tarea periódica reintenta el borrado.

Se conserva un registro mínimo de identificador/ruta, sin propietario, descripción ni hash de imagen, para impedir que un reenvío resucite el archivo y para retirar escrituras tardías. El borrado no puede retirar copias que otra persona ya haya visto/capturado ni alterar de inmediato las retenciones de recuperación del proveedor. No hay una papelera recuperable desde PhoTown.

Las fotografías del sprint 1 no tenían publisher y no se atribuyen automáticamente a ningún navegador. Cada nueva participación genera una identidad persistente con cookie HttpOnly; borrarla pierde el acceso automático a las fotos propias. El administrador puede reasignarlas mediante el procedimiento anterior, tras comprobar con la persona su autoría. No hay recuperación automática mediante Google ni correo del participante.

Las cookies pertenecen a cada dominio. Al cambiar desde workers.dev hay que entrar de nuevo con la invitación; las fotos hechas desde la dirección anterior siguen asociadas a la identidad de ese navegador en la dirección anterior. No se transfieren automáticamente entre dominios.

Instalar en pantalla de inicio puede abrir un contexto con identidad distinta: entrar con la invitación y utilizar recuperación administrativa si es necesario reasignar las fotos anteriores.

## Lista de espera

El botón «Lista de espera» de administración muestra emails y fecha de solicitud, con paginación de 50 filas. Permite eliminar una solicitud tras confirmación. Los datos no se exponen a participantes ni al público. Guardarlos no crea una identidad ni permite entrar a grupos; no se envían notificaciones. Revisar periódicamente las solicitudes y eliminar las que ya no sean necesarias. La migración 0003 añade únicamente esta tabla e índice.

## Muro de clase y foto identificativa

Cada grupo de administración tiene «Muro»: `/admin/wall?group=ID`, protegido por la sesión Google. Utiliza la misma presentación de marcos, alias, avatar y ALT del móvil, con más columnas en escritorio. Solo muestra publicaciones aprobadas; las pendientes/ocultas siguen en moderación. Abrir/cerrar una imagen restaura el foco sobre el muro.

En YO, «Editar mi perfil» permite alias y foto por grupo. La foto opcional puede proceder de un JPG/PNG/WebP del dispositivo; se recorta al centro a 256×256 en BN. El servidor valida WebP, limita a 128 KiB y 512×512, retira metadatos y guarda el avatar en una tabla privada D1. Reemplazarlo sobrescribe la imagen; eliminarlo borra la fila. La lectura de avatar por fotografía tiene los mismos permisos de visibilidad que la foto. La reasignación administrativa de fotos conserva el perfil del destino.

Las portadas circulares de grupos usan su última publicación aprobada, solo para miembros autorizados. No se añaden nuevas suscripciones ni acceso por pulsar una portada.
