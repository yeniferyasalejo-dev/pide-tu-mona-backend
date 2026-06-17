# Pruebas mínimas — Webhook Tpaga PSE

Ejecutar contra `http://localhost:3000` o la URL de Railway.

## Caso 1: Webhook válido y pago confirmado

```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:3000/tpaga/webhook" `
  -ContentType "application/json" `
  -Body '{"charge_token":"TOKEN_REAL","status":"settled","order_id":"ORDEN_UUID"}'
```

Esperado:
- HTTP 200, `{"received":true,"duplicate":false}`
- Orden pasa a `PAID`, inventario descontado, correo/WhatsApp enviados
- **No** debe aparecer en logs `[Tpaga] Error consultando cobro` con `source=webhook`

## Caso 2: Webhook duplicado

Repetir el mismo body del caso 1.

Esperado:
- HTTP 200, `{"received":true,"duplicate":true}`
- Sin segundo descuento de inventario ni segundo correo

## Caso 3: Payload inválido

```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:3000/tpaga/webhook" `
  -ContentType "application/json" `
  -Body '{}'
```

Esperado:
- HTTP 400, `{"received":false,"error":"charge_token is required"}`
- Log `[Tpaga Webhook] invalid_payload`

## Caso 4: Estado pendiente

```json
{"charge_token":"TOKEN","status":"pending"}
```

Esperado:
- HTTP 200
- Orden **no** pasa a `PAID`
- `tpaga_status` actualizado a `pending`

## Caso 5: Pago rechazado

```json
{"charge_token":"TOKEN","status":"charge-rejected","rejected_reason":"Transacción cancelada"}
```

Esperado:
- Orden `FAILED`
- Usuario notificado por WhatsApp/Telegram
- Sin descuento de inventario

## Caso 6: Bancos con caché válida

1. Primera llamada a `getBanks()` (vía flujo comprar) consulta Tpaga y persiste en `pse_bank_cache`
2. Segunda llamada dentro de 24h: sin log `[Tpaga] Error obteniendo bancos` ni nueva petición HTTP

## Caso 7: Caché vencida

1. Actualizar manualmente `pse_bank_cache.updated_at` a hace >24h
2. Una sola petición a Tpaga al siguiente `getBanks()`

## Caso 8: Tpaga falla al consultar bancos

1. Invalidar credenciales temporalmente o simular error de red
2. Con fila previa en `pse_bank_cache`, `getBanks()` devuelve la última lista válida

## Caso 9: Método contra entrega

1. Dejar `TPAGA_CLIENT_ID` / `TPAGA_CLIENT_SECRET` vacíos
2. Flujo WhatsApp: láminas → `comprar` → dirección → `si`
3. Esperado: orden `paymentMethod=COD`, correo de reserva, **sin** `tpagaChargeToken`

## Webhook solo con charge_token (comportamiento oficial Tpaga)

```json
{"charge_token":"TOKEN_REAL"}
```

Esperado:
- HTTP 200
- Log `status_missing_schedule_reconciliation`
- Reconciliación: máximo 3 consultas a Tpaga (30s, 2min, 5min), **no** desde el handler HTTP

## Caso 10: Recuperación tras reinicio (reconciliación persistente)

Prerrequisitos: migración aplicada, orden PSE con `tpaga_charge_token` en BD.

### Pasos

1. Enviar webhook solo con token (sin `status`):

```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:3000/tpaga/webhook" `
  -ContentType "application/json" `
  -Body '{"charge_token":"TOKEN_REAL_DE_ORDEN"}'
```

2. Verificar HTTP 200 y fila en `tpaga_reconciliations`:

```sql
SELECT charge_token, status, attempts, next_attempt_at
FROM tpaga_reconciliations
WHERE charge_token = 'TOKEN_REAL_DE_ORDEN';
```

Esperado: `status = PENDING`, `attempts = 0`.

3. **Reiniciar la aplicación** antes de que `next_attempt_at` llegue (o mientras el worker no haya corrido).

4. Volver a levantar `npm run dev` o `npm start`.

5. Esperar hasta 60s (tick del worker) o adelantar manualmente:

```sql
UPDATE tpaga_reconciliations
SET next_attempt_at = NOW() - INTERVAL '1 minute'
WHERE charge_token = 'TOKEN_REAL_DE_ORDEN';
```

6. Verificar que el worker procesa la fila sin reprocesar inventario/correos en duplicados:

```sql
SELECT status, attempts FROM tpaga_reconciliations WHERE charge_token = 'TOKEN_REAL';
SELECT status, tpaga_status FROM orders WHERE tpaga_charge_token = 'TOKEN_REAL';
SELECT processing_status FROM tpaga_webhook_events WHERE charge_token = 'TOKEN_REAL';
```

Esperado tras pago real en staging:
- `tpaga_reconciliations.status = COMPLETED`
- `orders.status = PAID` (si Tpaga reporta `settled`)
- `tpaga_webhook_events.processing_status = PROCESSED` (cuando aplica)

7. Reenviar el mismo webhook (duplicado):

```powershell
Invoke-RestMethod -Method POST ... -Body '{"charge_token":"TOKEN_REAL"}'
```

Esperado:
- HTTP 200, `duplicate: true`
- Sin segundo descuento de inventario
- Sin segundo correo (`confirmation_email_sent_at` ya poblado)
- Reconciliación no vuelve a `PENDING` si ya está `COMPLETED`


Ese mensaje **no existe** en este repositorio. Si aparece en producción, puede venir de:
- Un proxy o gateway delante de Railway
- Código desplegado distinto al de `main`
- Body JSON inválido rechazado antes de llegar al router (Express devuelve HTML `Bad Request`)

Los errores internos del webhook responden `{"received":false,"error":"internal_error"}` con log `[Tpaga Webhook] handler_failed`.

## Limitación conocida: correo de confirmación duplicado

Si el proveedor de correo confirma el envío pero la aplicación se reinicia **antes** de persistir `confirmation_email_status = SENT` (y `confirmation_email_sent_at`), un reintento puede volver a enviar el correo.

Mitigación actual: claim atómico (`confirmation_email_status` PENDING → PROCESSING) reduce la ventana, pero no la elimina por completo sin idempotencia del proveedor (p. ej. clave de idempotencia en la API de email).

No se planea más refactorización en este punto salvo que el proveedor soporte claves de idempotencia.

## Verificación automatizada pre-commit

```bash
# Requiere PostgreSQL (p. ej. contenedor Docker en :5433)
DATABASE_URL="postgresql://postgres:test@localhost:5433/ptm_verify" npx ts-node scripts/verify-tpaga-final.ts
```

Cubre: claim atómico (`updateMany.count === 1`), concurrencia de workers, rollback transaccional de `settleOrderPayment`, Caso 10, y pruebas de estados Tpaga.
