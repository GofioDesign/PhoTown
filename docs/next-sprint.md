# Próximos sprints

El rediseño YO — cámara — grupo activo del Sprint 2 se describe en [sprint-2.md](sprint-2.md).

## Sprint 3 propuesto: cámara móvil y accesibilidad

- Alternar frontal/selfie y trasera con control accesible; detener la cámara anterior, admitir una sola cámara y recuperar errores sin perder capturas.
- Mantener BN en ambas cámaras y comprobar encuadre, orientación y espejo de la frontal.
- Probar Safari/iPhone y Chrome/Android físicos: permisos, vertical/horizontal, instalación, teclado, descarga individual/ZIP, retorno desde otra aplicación.
- Revisar con VoiceOver, TalkBack, ampliación y personas con distintas discapacidades; ajustar tamaño, foco, contraste y pulsación prolongada según resultados.

## Sprint 4 propuesto: Weekly Review

- Selección de semana, orden estable, contador y recorrido de fotos.
- Flechas y Escape por teclado; pantalla de escritorio, TV y proyector.
- Evaluar tamaño/calidad de imágenes reales antes de crear derivados para el muro.

## Preparación del piloto

- Revisión de privacidad, borrado, lista de espera, límites y procedimientos administrativos.
- Evaluar decodificación/normalización BN en servidor para clientes manipulados.
- Piloto con 5–10 personas durante una semana; recoger incidencias y aprendizaje.

## Más adelante

Ayuda opcional de exposición: señalar zonas de altas luces y sombras recortadas, con indicador que no dependa exclusivamente del rojo. Definir umbrales y comprobar utilidad real antes de desarrollarlo.

## Evolución solicitada tras el rediseño del muro

- Herramientas de análisis en el muro de clase: dibujar líneas rectas, curvas/círculos sobre la imagen ampliada; definir borrar/deshacer y si las anotaciones se conservan. Mantener intacta la fotografía original.
- Administradores propios por grupo. Superadmin restringido a eliminar o resetear grupos; definir exactamente qué conserva o elimina un reseteo antes de implementar operaciones irreversibles. Este cambio de roles no está activo todavía: los administradores actuales conservan sus permisos.

## Correcciones para el siguiente despliegue

### Equivalencia de direcciones Gmail

`gofio.design@gmail.com` y `gofiodesign@gmail.com` pertenecen al mismo buzón de Gmail, pero actualmente PhoTown los interpreta como identidades diferentes. Hay que definir una función canónica única para todos los puntos de entrada y comparación de correos OAuth.

- Ignorar los puntos de la parte local únicamente para `gmail.com`; no aplicar esta regla a otros dominios.
- Decidir y probar expresamente el tratamiento de `googlemail.com` y de los sufijos `+alias`; no extender la equivalencia por suposición.
- Usar el `sub` verificado de Google como identificador estable del proveedor y el correo canónico para asignaciones y búsquedas.
- Migrar o reconciliar asignaciones existentes sin crear dos usuarios ni perder roles.
- Añadir pruebas para correos equivalentes y para dominios donde los puntos sí cambian la dirección.

### Rol owner por grupo

Añadir `owner` como rol de grupo separado de `admin` y `moderator`.

- `owner` puede añadir, cambiar y eliminar admins y moderators de su grupo.
- `admin` y `moderator` no pueden conceder, retirar ni modificar roles administrativos.
- Definir quién asigna el owner inicial al crear o migrar un grupo.
- Un grupo debe conservar al menos un owner activo; impedir eliminar o degradar al último owner.
- Definir el procedimiento de transferencia de ownership y registrar quién realizó cada cambio.
- Superadmin y owner siguen siendo dimensiones separadas: ser superadmin no concede automáticamente ownership.
- La interfaz debe mostrar los roles asignados y ofrecer editar/eliminar solo cuando el contexto seleccionado tenga permiso.
- El cambio requiere una nueva migración D1 y pruebas de escalada de privilegios, último owner y aislamiento entre grupos.

### Vinculación OAuth desde YO

Permitir que una persona con identidad local vincule voluntariamente su cuenta OAuth desde el menú personal de YO.

- Mostrar una acción clara como `Vincular cuenta con Google` en Personalización/YO.
- Iniciar OAuth conservando la sesión local y usando `state`, `nonce` y PKCE.
- Tras el callback, vincular el proveedor al USER local actual; no crear otro USER cuando la vinculación sea válida.
- Si el `sub` o el correo ya están vinculados a otro USER, detener el proceso y ofrecer un flujo explícito de conciliación; nunca fusionar automáticamente fotografías o roles.
- Mantener fotografías, PAR-ID, membresías, trust y estados existentes.
- Informar antes de vincular qué dato se guarda y permitir cancelar.
- Añadir pruebas de éxito, callback sin sesión local, repetición idempotente, proveedor ya vinculado, CSRF/replay y conflicto entre usuarios.

Estas tres correcciones están documentadas, pero no implementadas ni desplegadas.
