# Aula Meet

Videollamadas con chat para clases: cámara, micrófono, compartir pantalla y chat en grupo.
Sin cuentas ni registro: cada clase es una sala con un código (por ejemplo `matematicas-3b`).

## Usarlo en tu ordenador

```bash
npm install
npm start
```

Abre http://localhost:3000, escribe tu nombre y pulsa **Crear clase nueva**. Aparece el
enlace de la clase (`https://tu-web/sala/clase-xxxx-xxxx`) para copiarlo y mandarlo.
Quien abre el enlace solo escribe su nombre y entra.

## Publicarlo en internet (gratis) para tus estudiantes

La cámara y el micrófono solo funcionan con **https**, así que hay que subirlo a un hosting.
Paso a paso en **[GUIA-PUBLICAR.md](GUIA-PUBLICAR.md)** (GitHub + Render, gratis; `render.yaml` ya incluido).

(También funciona igual en Railway, Fly.io o cualquier servidor con Node 18+.)

## Ajustes

- `MAX_PER_ROOM` (variable de entorno): máximo de personas por sala. Por defecto 12.

## Límites a tener en cuenta

- Cada participante envía su vídeo directamente a todos los demás (WebRTC "mesh").
  Va muy bien hasta unas **8–10 personas** con cámara. Para clases más grandes,
  pide a los estudiantes que apaguen la cámara o habría que pasar a un servidor de
  medios (SFU como LiveKit o mediasoup).
- Algunas redes muy cerradas (de empresa o de algunos colegios) bloquean la conexión
  directa. En ese caso hace falta un servidor TURN: añádelo en `ICE_SERVERS`,
  al principio de `public/app.js`.
- El chat no se guarda: solo lo ven quienes están en la sala en ese momento.
