// scripts/check-recordatorios.js
//
// Este script corre en GitHub Actions (gratis, sin necesidad del plan Blaze).
// 1) Revisa Firestore buscando recordatorios pendientes de hoy.
// 2) Si ya toca avisar, manda un CORREO, un mensaje de TELEGRAM y, si hay
//    tokens registrados, también un push por FCM.
// 3) Marca el recordatorio como enviado para no repetirlo.
// 4) También avisa la noche anterior sobre los recordatorios de "mañana".
//
// Requiere las variables de entorno:
//   FIREBASE_SERVICE_ACCOUNT  → JSON de la cuenta de servicio de Firebase
//   GMAIL_USER                → cuenta de Gmail que ENVÍA el correo
//   GMAIL_APP_PASSWORD        → contraseña de aplicación de esa cuenta (16 letras)
//   TELEGRAM_BOT_TOKEN        → token del bot (te lo da @BotFather)
//   TELEGRAM_CHAT_ID          → tu ID de chat de Telegram
// (ver INSTRUCCIONES.md)

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const CORREO_DESTINO = 'elprofechan@gmail.com';

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

async function enviarCorreo(asunto, mensaje) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
        console.warn('Faltan GMAIL_USER / GMAIL_APP_PASSWORD, no se puede mandar el correo.');
        return;
    }
    try {
        await transporter.sendMail({
            from: `"Asistente Escolar" <${process.env.GMAIL_USER}>`,
            to: CORREO_DESTINO,
            subject: asunto,
            text: mensaje
        });
        console.log(`Correo enviado a ${CORREO_DESTINO}: ${asunto}`);
    } catch (e) {
        console.error('Error enviando correo:', e.message);
    }
}

async function enviarTelegram(asunto, mensaje) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.warn('Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, no se puede mandar el Telegram.');
        return;
    }
    try {
        const texto = `*${asunto}*\n${mensaje}`;
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' })
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.description || 'Error desconocido de Telegram');
        console.log(`Telegram enviado: ${asunto}`);
    } catch (e) {
        console.error('Error enviando Telegram:', e.message);
    }
}

function pad(n) {
    return n.toString().padStart(2, '0');
}

// Usamos la hora de Ciudad de México, sin importar dónde corra el runner de GitHub.
function ahoraCDMX() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
}

async function obtenerTokens() {
    const snap = await db.collection('fcm_tokens').where('activo', '==', true).get();
    return snap.docs.map((d) => d.id);
}

async function notificar(titulo, cuerpo) {
    // Correo y Telegram: siempre se intentan, son las vías principales ahora.
    await enviarCorreo(titulo, cuerpo);
    await enviarTelegram(titulo, cuerpo);

    // Push: solo si hay tokens registrados (bonus). Va en su propio try/catch
    // para que, si falla por lo que sea, NO tumbe el correo/Telegram que ya
    // se mandaron arriba, ni impida marcar el recordatorio como enviado.
    try {
        const tokens = await obtenerTokens();
        if (tokens.length === 0) {
            console.log('No hay tokens de push registrados (solo se mandó correo/Telegram).');
            return;
        }

        const respuesta = await messaging.sendEachForMulticast({
            tokens,
            notification: { title: titulo, body: cuerpo },
            webpush: {
                fcmOptions: { link: '/' },
                notification: { icon: 'https://raw.githubusercontent.com/mke210/asistente-escolar/main/asistente-virtual.png' }
            }
        });

        // Limpieza: si un token ya no es válido (usuario desinstaló, bloqueó, etc.), lo borramos.
        const tokensInvalidos = [];
        respuesta.responses.forEach((r, i) => {
            if (!r.success) {
                const code = r.error && r.error.code;
                if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                    tokensInvalidos.push(tokens[i]);
                }
            }
        });
        for (const t of tokensInvalidos) {
            await db.collection('fcm_tokens').doc(t).delete();
        }

        console.log(`Push enviado: ${respuesta.successCount} ok, ${respuesta.failureCount} fallidos, ${tokensInvalidos.length} tokens limpiados.`);
    } catch (e) {
        console.error('Error enviando push (no afecta correo/Telegram):', e.message);
    }
}

async function revisarRecordatoriosDeHoy(hoy, horaActual) {
    const snap = await db.collection('recordatorios')
        .where('enviado', '==', false)
        .where('fecha', '==', hoy)
        .get();

    for (const doc of snap.docs) {
        const r = doc.data();
        let debeNotificar = false;

        if (r.hora) {
            const [horaRec, minRec] = r.hora.split(':').map(Number);
            const [horaAct, minAct] = horaActual.split(':').map(Number);
            const minutosRec = horaRec * 60 + minRec;
            const minutosAct = horaAct * 60 + minAct;
            // Ventana de 15 min antes a 5 min después de la hora programada
            if (minutosAct >= minutosRec - 15 && minutosAct <= minutosRec + 5) {
                debeNotificar = true;
            }
        } else {
            // Sin hora específica: se manda por la mañana
            if (horaActual >= '08:00' && horaActual <= '08:10') {
                debeNotificar = true;
            }
        }

        if (debeNotificar) {
            try {
                const mensaje = `${r.titulo}${r.descripcion ? ' — ' + r.descripcion : ''}${r.hora ? ' (⏰ ' + r.hora + ')' : ''}`;
                await notificar('🔔 Recordatorio escolar de hoy', mensaje);
                await doc.ref.update({ enviado: true, fechaEnvio: new Date().toISOString() });
                console.log(`Recordatorio enviado: ${r.titulo}`);
            } catch (e) {
                // Si este recordatorio falla, se sigue con los demás en vez de
                // detener todo el proceso — se reintentará en la próxima corrida.
                console.error(`Error procesando el recordatorio "${r.titulo}":`, e.message);
            }
        }
    }
}

async function avisarRecordatoriosDeManana(horaActual, mananaStr) {
    if (!(horaActual >= '20:00' && horaActual <= '20:10')) return;

    const snap = await db.collection('recordatorios')
        .where('enviado', '==', false)
        .where('fecha', '==', mananaStr)
        .get();

    for (const doc of snap.docs) {
        const r = doc.data();
        if (r.avisoPrevioEnviado === true) continue; // ya se avisó, no repetir
        const mensaje = `Mañana: ${r.titulo}${r.hora ? ' (⏰ ' + r.hora + ')' : ''}`;
        await notificar('📅 Recordatorio para mañana', mensaje);
        await doc.ref.update({ avisoPrevioEnviado: true });
        console.log(`Aviso previo enviado: ${r.titulo}`);
    }
}

async function main() {
    const ahora = ahoraCDMX();
    const hoy = `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}`;
    const horaActual = `${pad(ahora.getHours())}:${pad(ahora.getMinutes())}`;

    const manana = new Date(ahora);
    manana.setDate(manana.getDate() + 1);
    const mananaStr = `${manana.getFullYear()}-${pad(manana.getMonth() + 1)}-${pad(manana.getDate())}`;

    console.log(`Revisando recordatorios — hoy ${hoy} ${horaActual}`);

    await revisarRecordatoriosDeHoy(hoy, horaActual);
    await avisarRecordatoriosDeManana(horaActual, mananaStr);

    console.log('Listo.');
}

main().catch((err) => {
    console.error('Error en check-recordatorios:', err);
    process.exit(1);
});
