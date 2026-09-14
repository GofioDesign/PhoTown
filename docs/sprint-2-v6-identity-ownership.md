# Sprint 2 v6 identidad vinculada y propiedad de grupos

## Objetivo

Corregir la equivalencia de direcciones Gmail, introducir ownership real por grupo y permitir que una identidad local se vincule voluntariamente con Google OAuth desde YO. El sprint debe mantener separadas la autoridad global de superadmin, la propiedad del grupo y la participación ordinaria.

## Estado de partida verificado

La auditoría remota de D1 del 14 de septiembre de 2026 encontró 3 grupos sin owner, 2 asignaciones admin, 1 membresía admin reclamada y 1 conjunto de asignaciones duplicadas por puntos en una dirección `gmail.com`. No hay colisiones entre USER OAuth existentes.

Este estado impide promover administradores automáticamente: al menos un grupo no tiene una asignación admin y las dos filas Gmail equivalentes deben reconciliarse antes de establecer ownership.

## Alcance

### Identidad canónica Gmail

Crear una única función de normalización utilizada al leer `SUPERADMIN_EMAILS`, recibir una asignación, procesar claims OAuth y buscar identidades.

Reglas de este sprint:

- Recortar espacios y convertir el dominio y la parte local a minúsculas.
- Eliminar puntos de la parte local solo cuando el dominio sea exactamente `gmail.com`.
- No eliminar sufijos `+alias` ni convertir `googlemail.com` en este sprint.
- Mantener el correo original verificado para mostrarlo; almacenar además el valor canónico para comparar y aplicar restricciones únicas.
- Identificar una cuenta Google por el claim verificado `sub`. El correo canónico sirve para encontrar asignaciones, no para sustituir `sub`.

La migración debe consolidar la colisión detectada sin duplicar USER ni permisos. Si dos filas equivalentes tienen roles distintos, se conserva el de mayor autoridad según `owner > admin > moderator`; el caso debe quedar registrado en el informe de migración.

### Owner de grupo

Añadir `owner` a los roles de `group_memberships` y `group_role_assignments` mediante `0006_identity_ownership.sql`.

- Cada grupo tendrá exactamente un owner activo.
- Owner puede añadir, cambiar y eliminar admins y moderators únicamente en su grupo.
- Admin conserva la gestión operativa del grupo y de sus fotografías, pero no gestiona roles.
- Moderator conserva únicamente las capacidades de moderación acordadas.
- Superadmin no obtiene ownership ni administración ordinaria por defecto.
- Superadmin puede designar el primer owner solo mientras un grupo no tenga owner. Una vez asignado, el cambio se realiza mediante transferencia explícita del owner actual.
- No se permite eliminar, degradar ni bloquear al owner sin completar una transferencia.
- Cada alta, cambio, retirada o transferencia genera un evento de auditoría con grupo, actor, afectado, rol anterior, rol nuevo y fecha.

La interfaz sustituirá `Administración del grupo` por una lista de roles con controles acordes al contexto. El selector de acceso mostrará `Owner · grupo`, `Admin · grupo`, `Moderator · grupo` y `Superadmin` como dimensiones independientes.

### Vinculación OAuth desde YO

Añadir en Personalización una sección de cuenta con la acción `Vincular cuenta con Google`.

- El inicio exige una sesión local activa y explica que se guardarán el identificador Google y el correo verificado.
- El flujo usa estado de un solo uso, nonce y PKCE, separado del OAuth administrativo.
- El callback exige que siga presente la misma identidad local que inició la operación.
- La vinculación inserta el proveedor sobre el USER local actual y conserva fotografías, PAR-ID, membresías, trust y estados.
- Repetir la misma vinculación es idempotente.
- Si `sub` o correo canónico pertenecen a otro USER, no se fusiona nada: se detiene el flujo y se informa del conflicto.
- YO muestra si la cuenta está vinculada y el correo verificado, sin exponerlo a otros participantes.

Desvincular, fusionar usuarios y recuperar acceso en otro dispositivo quedan fuera de este sprint. Deben diseñarse después sobre la identidad ya vinculada.

## Datos y migración 0006

La migración se implementará y probará primero contra una copia completa de 0001–0005.

1. Añadir correo canónico a proveedores y asignaciones, preservando el correo verificado para presentación.
2. Reconciliar las filas Gmail equivalentes antes de crear índices únicos canónicos.
3. Reconstruir las tablas con `owner` en sus restricciones de rol, conservando claves y referencias.
4. Crear la restricción que impide más de un owner por grupo.
5. Crear una tabla append-only de eventos de roles.
6. No promover automáticamente administradores durante la migración.
7. Permitir el bootstrap de owner por superadmin solo para los 3 grupos que inicialmente no lo tienen.

Antes del despliegue se preparará una lista privada —no versionada— con el owner inicial de cada grupo. El cierre del despliegue exige que los 3 grupos tengan owner.

## API y autorización

- La sesión administrativa devolverá contextos `superadmin`, `owner`, `admin` y `moderator`.
- Las rutas de roles aceptarán el contexto de grupo ya validado por el Worker.
- Solo owner podrá crear, modificar o eliminar asignaciones admin/moderator.
- La transferencia de owner tendrá una operación dedicada y atómica.
- Superadmin solo podrá ejecutar el bootstrap cuando la consulta confirme que no existe owner.
- Las rutas OAuth de participante estarán separadas de `/api/admin/google/*` y no emitirán una cookie administrativa.
- Todas las mutaciones mantendrán comprobación same-origin, límites de cuerpo, rate limit e idempotencia donde proceda.

## Orden de implementación

1. Función de correo canónico y pruebas unitarias.
2. Migración 0006 y prueba de migración completa con colisión Gmail.
3. Modelo owner, auditoría y autorización de servidor.
4. API para listar, asignar, retirar y transferir roles.
5. Selector y panel de owner en Administración.
6. OAuth de vinculación de participante y estado de cuenta en YO.
7. Pruebas integradas, revisión de accesibilidad y bundle Wrangler.
8. Revisión final de seguridad y preparación del runbook de producción.

## Criterios de aceptación

- Las variantes con y sin puntos de una dirección `gmail.com` resuelven la misma asignación; en otros dominios siguen siendo distintas.
- La colisión remota existente se consolida sin perder el rol efectivo ni crear usuarios.
- Cada grupo termina con exactamente un owner.
- Owner puede gestionar admins/moderators de su grupo y no los de otro.
- Admin, moderator y superadmin sin contexto owner reciben 403 al intentar gestionar roles, salvo el bootstrap inicial permitido a superadmin.
- El último owner no puede eliminarse ni degradarse; una transferencia completa cambia el owner de forma atómica.
- Un participante puede vincular Google desde YO y conserva todas sus fotografías y membresías.
- Un conflicto OAuth entre USER distintos no modifica datos.
- Los 28 tests actuales siguen pasando y se añaden casos de normalización, migración, ownership, aislamiento, OAuth, CSRF, replay e idempotencia.
- El bundle `wrangler deploy --dry-run` termina correctamente.

## Despliegue y rollback

1. Revisar y fusionar la rama solo después de aprobar la migración y los recorridos críticos.
2. Exportar D1 remoto y registrar la versión Worker activa.
3. Aplicar `0006_identity_ownership.sql` a D1 remoto.
4. Verificar tablas, colisión reconciliada y ausencia de owners creados por accidente.
5. Desplegar el Worker.
6. Designar de forma privada los 3 owners iniciales mediante el bootstrap de superadmin.
7. Confirmar que cada grupo tiene exactamente un owner y probar los cuatro contextos.
8. Probar vinculación OAuth con una identidad de ensayo sin fotografías reales.

Si se revierte el Worker después de asignar owners, el runbook debe convertir temporalmente esos roles a admin mediante SQL compensatorio antes del rollback, porque el Worker anterior no reconoce `owner`. No se revierte D1 destruyendo la migración; se restaura desde el backup únicamente ante pérdida o corrupción comprobada.

## Fuera de alcance

- Eliminación o reset de grupos por superadmin.
- Recuperación OAuth en otro dispositivo y fusión de USER.
- Alias `+tag` y equivalencia `googlemail.com`.
- Cámara móvil, herramientas de dibujo, Weekly Review, retención y capacidad.

Estas funciones continúan en el backlog posterior y no deben añadirse durante este sprint.
