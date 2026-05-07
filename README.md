# Pide Tu Mona — Backend

Backend para **Pide Tu Mona**, una plataforma de intercambio de monas (stickers) del álbum del Mundial 2026. Los usuarios interactúan vía Telegram: le escriben al bot [@mundial26_bot](https://t.me/mundial26_bot), registran su nombre, email y las láminas que les faltan.

## Stack

- **Node.js + TypeScript** con Express
- **PostgreSQL** (Supabase) en producción / **SQLite** en desarrollo
- **Prisma** como ORM
- **Telegram Bot API** para mensajería
- **Railway** para hosting

## Cómo correr localmente

### 1. Clonar e instalar

```bash
git clone <tu-repo>
cd pide-tu-mona-backend
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` con tus valores:

```
DATABASE_URL="file:./dev.db"
TELEGRAM_BOT_TOKEN=tu_token_de_botfather
ADMIN_TOKEN=cualquier_string
PORT=3000
```

### 3. Crear la base de datos

```bash
npm run db:push
```

### 4. Arrancar el servidor

```bash
npm run dev
```

El servidor corre en `http://localhost:3000`. Prueba con:

```bash
curl http://localhost:3000/health
```

### 5. Explorar la base de datos (opcional)

```bash
npm run db:studio
```

## Configurar el webhook de Telegram

Telegram necesita una URL pública para enviar mensajes al bot. Hay dos opciones:

### Opción A: con ngrok (desarrollo local)

1. Instala ngrok: https://ngrok.com/download
2. Corre el servidor: `npm run dev`
3. En otra terminal: `ngrok http 3000`
4. Copia la URL pública y abre en el navegador:

```
https://tu-url.ngrok-free.app/setup-webhook?url=https://tu-url.ngrok-free.app
```

### Opción B: en producción (Railway)

Una vez deployado, abre en el navegador:

```
https://tu-app.railway.app/setup-webhook?url=https://tu-app.railway.app
```

## Endpoints

| Método | Ruta | Descripción | Auth |
|--------|------|-------------|------|
| GET | `/health` | Health check | No |
| POST | `/webhook` | Recibe mensajes de Telegram | No |
| GET | `/setup-webhook?url=...` | Configura el webhook de Telegram | No |
| GET | `/users` | Lista todos los usuarios | `x-admin-token` |
| GET | `/users/:id` | Detalle de un usuario | `x-admin-token` |

## Comandos del bot

| Comando | Descripción |
|---------|-------------|
| `/start` | Inicia o reinicia el registro |
| `/ayuda` o `/help` | Muestra comandos disponibles |
| `/actualizar` o `actualizar` | Actualiza la lista de láminas (solo si ya completó el registro) |

## Deploy en Railway

1. Crea una cuenta en [railway.app](https://railway.app)
2. Conecta tu repositorio de GitHub
3. Configura las variables de entorno en el dashboard:
   - `DATABASE_URL` → connection string de Supabase
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_TOKEN`
4. Build command: `npm run build`
5. Start command: `npm start`
6. Una vez deployado, visita `/setup-webhook?url=https://tu-app.railway.app` para conectar Telegram

## Scripts disponibles

| Comando | Qué hace |
|---------|----------|
| `npm run dev` | Servidor en modo desarrollo con hot reload |
| `npm run build` | Compila TypeScript y genera Prisma Client |
| `npm start` | Corre la versión compilada (producción) |
| `npm run db:push` | Sincroniza el schema de Prisma con la DB |
| `npm run db:studio` | Abre Prisma Studio para explorar datos |

## Fase 2 (pendiente)

- [ ] Matching automático entre usuarios
- [ ] Notificaciones cuando hay un match
- [ ] Logística de envío / punto de encuentro
- [ ] Pagos o sistema de créditos
- [ ] Dashboard web para administración
- [ ] Rate limiting
- [ ] Tests automatizados
