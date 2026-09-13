# Sprint 1 núcleo de datos y permisos v6

## Resultado

Este sprint introduce mediante una migración aditiva la base persistente del programa v6 sin deduplicar, borrar ni reinterpretar las fotografías existentes. Todos los grupos anteriores se migran como identificados y reciben un WALL inicial que contiene sus publicaciones actuales en orden cronológico estable.

Las cuentas Google autorizadas actuales continúan como superadmin global y, cuando se autentican, reciben también una membresía admin independiente en los grupos existentes. El rol global y el rol de grupo se almacenan y evalúan por separado.

## Modelo añadido

- USER global y estado de cuenta.
- Proveedores de identidad OAuth vinculados a USER.
- Rol global `superadmin`.
- MEMBERSHIP por USER y GROUP con PAR-ID, rol, estado y trust separados.
- GROUP identificado con zona horaria, retención, periodicidad, capacidad, asientos y estado operativo preparados para fases posteriores.
- PHOTO con USER, PAR-ID, origen único, `published_at` y tamaño almacenado.
- WALL persistente y relación ordenada entre WALL y PHOTO.

Las tablas y columnas del prototipo se conservan temporalmente como puente de compatibilidad. No son el modelo de destino.

## Migración de datos existentes

1. Cada `publisher` se convierte en un USER local conservando su credencial de navegador.
2. Cada membresía anterior genera una MEMBERSHIP v6 y un PAR-ID propio.
3. `TRUSTED` se convierte en trust activo y `BLOCKED` en estado bloqueado; el rol inicial del participante sigue siendo `user`.
4. Cada GROUP se marca como `identified` y conserva `Atlantic/Canary` como zona inicial de esta instalación.
5. Cada fila PHOTO se conserva como fotografía independiente. Coincidir en hash no provoca una fusión.
6. Las PHOTO publicadas reciben `published_at` a partir de su fecha existente cuando no hay otro dato histórico.
7. Cada GROUP recibe un WALL abierto y todas sus PHOTO publicadas se incorporan por `created_at` e identificador ascendente.
8. No se inventan WALLS históricos que el prototipo no almacenó.

## Cambios de comportamiento

CAMERA fija el GROUP de origen al capturar. La vista previa informa de ese grupo y ya no permite elegir varios destinos. El servidor rechaza un intento de enviar esa captura a otro grupo.

Una publicación de confianza recibe `published_at` y se añade al final del WALL abierto. Una aprobación administrativa hace lo mismo de forma idempotente.

Las lecturas administrativas de fotografías y avatares comprueban ahora una membresía admin o moderator del GROUP. Las operaciones administrativas mutables actuales requieren admin. La allowlist OAuth continúa habilitando el acceso de las dos cuentas actuales, pero su autoridad de grupo se materializa en MEMBERSHIP.

## Compatibilidad temporal

- Alias y avatar siguen referenciando `publisher_id` durante la transición.
- La interfaz de moderación anterior sigue mostrando `NEW`, `MODERATED`, `TRUSTED` y `BLOCKED`, traducidos al modelo nuevo al guardar.
- La biblioteca personal ya consulta `user_id`; para identidades locales migradas, USER y publisher comparten inicialmente el identificador.
- El código conserva las rutas existentes para no romper el cliente publicado.

## Verificación

- Comprobación sintáctica superada.
- 26 pruebas de Node superadas.
- Prueba específica de migración 0001 a 0005 superada con conservación de autoría, copias, trust, bloqueo y orden del WALL.
- Prueba de separación entre superadmin global y autoridad admin por grupo superada.
- Empaquetado de Cloudflare Worker superado.
- Los recorridos Playwright se actualizaron al origen único, pero no se ejecutaron en este entorno porque la descarga de Chromium agotó repetidamente el tiempo de red.

## Fuera de este sprint

Este sprint no implementa todavía OAuth participante, grupos anónimos nuevos, salida, suspensión, retención efectiva, capacidad, reset de WALL, históricos, expedientes de moderación, WALL REVIEW, ARCHIVE personal, CHALLENGES ni LEARNING PRODUCT. El esquema deja preparados los límites necesarios, pero su comportamiento corresponde a sprints posteriores.
