# Imagen del servidor: la misma imagen sirve para la API y para el worker, solo cambia el comando.
# Se construye desde la raíz del repositorio:
#   docker build -f docker/Dockerfile -t pos-servidor .

# --- Dependencias de producción ---
# bcrypt se compila si no hay binario para Alpine; por eso aquí están python3, make y g++.
FROM node:20-alpine AS dependencias
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY paquetes/compartido/package.json paquetes/compartido/
COPY apps/servidor/package.json apps/servidor/
RUN npm ci --omit=dev

# --- Compilación de TypeScript ---
FROM dependencias AS compilacion
RUN npm ci
COPY tsconfig.base.json ./
COPY paquetes/compartido paquetes/compartido
COPY apps/servidor/src apps/servidor/src
COPY apps/servidor/tsconfig.build.json apps/servidor/
RUN npm run build -w @pos/compartido && npm run build -w @pos/servidor

# --- Imagen final: solo lo necesario para correr ---
FROM node:20-alpine
# pg_dump y pg_restore de la misma versión que el servidor (para los respaldos) y zonas horarias.
RUN apk add --no-cache postgresql16-client tzdata
ENV NODE_ENV=production TZ=America/Mazatlan
WORKDIR /app
COPY --from=dependencias /app/node_modules node_modules
COPY package.json ./
COPY paquetes/compartido/package.json paquetes/compartido/
COPY --from=compilacion /app/paquetes/compartido/dist paquetes/compartido/dist
COPY apps/servidor/package.json apps/servidor/
COPY --from=compilacion /app/apps/servidor/dist apps/servidor/dist
# Corre sin privilegios de administrador, por seguridad.
USER node
WORKDIR /app/apps/servidor
EXPOSE 8080
CMD ["node", "dist/main-api.js"]
