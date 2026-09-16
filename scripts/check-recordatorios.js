// scripts/check-recordatorios.js
//
// Este script corre en GitHub Actions (gratis, sin necesidad del plan Blaze).
// En cada corrida (cada 5 min):
// 1) Revisa Firestore buscando recordatorios pendientes de hoy.
// 2) Avisa la noche anterior sobre los recordatorios de "mañana".
// 3) Revisa tu horario de clases y, si toca avisar de una clase próxima,
//    manda el aviso incluyendo el TEMA que estés viendo en ese grado/grupo
//    (colección "temas"), si hay uno vigente.
// 4) Avisa cuando un tema de clase esté por terminar (llega a su fecha fin),
//    para que no se te olvide registrar el siguiente.
// Todo esto respeta lo que configures en Administración > ⏰ Config. Recordatorios
// (medios de envío, minutos de anticipación, si cada tipo de aviso está
// habilitado, etc.) — antes esa pantalla guardaba la configuración pero el
// script no la leía; ahora sí.
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

// Debe ser el MISMO default que NOTIF_CONFIG_DEFAULT en index.html, para que
// el comportamiento sea igual antes de que el usuario guarde su configuración
// por primera vez.
const NOTIF_CONFIG_DEFAULT = {
    correo: true,
    telegram: true,
    push: true,
    clasesProximas: true,
    recordatoriosHoy: true,
    avisoManana: true,
    horaAvisoManana: '20:00',
    diasAvisoManana: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'],
    minutosAntesClase: 10,
    minutosAntesRecordatorio: 15
};

async function obtenerConfigNotificaciones() {
    const doc = await db.collection('config').doc('notificaciones').get();
    return { ...NOTIF_CONFIG_DEFAULT, ...(doc.exists ? doc.data() : {}) };
}

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

// "cfg" es la configuración de config/notificaciones: decide por qué medios
// se manda cada aviso (correo/Telegram/push).
async function notificar(titulo, cuerpo, cfg) {
    if (cfg.correo) await enviarCorreo(titulo, cuerpo);
    if (cfg.telegram) await enviarTelegram(titulo, cuerpo);

    // Push: solo si hay tokens registrados (bonus) y está habilitado. Va en
    // su propio try/catch para que, si falla, NO tumbe el correo/Telegram
    // que ya se mandaron arriba.
    if (!cfg.push) return;
    try {
        const tokens = await obtenerTokens();
        if (tokens.length === 0) {
            console.log('No hay tokens de push registrados.');
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

async function revisarRecordatoriosDeHoy(hoy, horaActual, cfg) {
    if (!cfg.recordatoriosHoy) return;

    const snap = await db.collection('recordatorios')
        .where('enviado', '==', false)
        .where('fecha', '==', hoy)
        .get();

    for (const doc of snap.docs) {
        const r = doc.data();
        if (r.activo === false) continue;
        let debeNotificar = false;

        if (r.hora) {
            const [horaRec, minRec] = r.hora.split(':').map(Number);
            const [horaAct, minAct] = horaActual.split(':').map(Number);
            const minutosRec = horaRec * 60 + minRec;
            const minutosAct = horaAct * 60 + minAct;
            // Ventana: X min antes (según config) a 5 min después de la hora programada
            if (minutosAct >= minutosRec - cfg.minutosAntesRecordatorio && minutosAct <= minutosRec + 5) {
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
                await notificar('🔔 Recordatorio escolar de hoy', mensaje, cfg);
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

async function avisarRecordatoriosDeManana(horaActual, mananaStr, diaSemanaId, cfg) {
    if (!cfg.avisoManana) return;
    if (!cfg.diasAvisoManana.includes(diaSemanaId)) return;
    const horaObjetivo = cfg.horaAvisoManana || '20:00';
    const [hObj, mObj] = horaObjetivo.split(':').map(Number);
    const minutosObjetivo = hObj * 60 + mObj;
    const [hAct, mAct] = horaActual.split(':').map(Number);
    const minutosActuales = hAct * 60 + mAct;
    // Ventana de 10 min para no depender de que el cron caiga justo al minuto exacto
    if (!(minutosActuales >= minutosObjetivo && minutosActuales <= minutosObjetivo + 10)) return;

    const snap = await db.collection('recordatorios')
        .where('enviado', '==', false)
        .where('fecha', '==', mananaStr)
        .get();

    for (const doc of snap.docs) {
        const r = doc.data();
        if (r.activo === false) continue;
        if (r.avisoPrevioEnviado === true) continue; // ya se avisó, no repetir
        const mensaje = `Mañana: ${r.titulo}${r.hora ? ' (⏰ ' + r.hora + ')' : ''}`;
        await notificar('📅 Recordatorio para mañana', mensaje, cfg);
        await doc.ref.update({ avisoPrevioEnviado: true });
        console.log(`Aviso previo enviado: ${r.titulo}`);
    }
}

// Convierte el día de la semana (según ahoraCDMX) al mismo id que usa
// HORARIO_DIAS en index.html: 'lunes'..'viernes' (null si es fin de semana).
function diaSemanaId(fecha) {
    const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const id = dias[fecha.getDay()];
    return (id === 'domingo' || id === 'sabado') ? null : id;
}

// Busca, entre los temas registrados, el que esté vigente hoy para un
// grado/grupo dado (fechaInicio <= hoy <= fechaFin). Si hay varios (no
// debería), toma el más reciente.
async function obtenerTemaVigente(grado, grupo, hoy) {
    const snap = await db.collection('temas').where('grado', '==', grado).where('grupo', '==', grupo).get();
    let vigente = null;
    snap.forEach((doc) => {
        const t = doc.data();
        if (t.fechaInicio <= hoy && hoy <= t.fechaFin) {
            if (!vigente || t.fechaInicio > vigente.fechaInicio) vigente = t;
        }
    });
    return vigente;
}

// Revisa el horario de clases (colección "horario", doc "maestro") y avisa
// de las clases próximas a empezar, incluyendo el tema vigente si hay uno.
// Usa la colección "avisos_clase_enviados" para no repetir el mismo aviso
// varias veces mientras dura la ventana (la corrida es cada 5 min).
async function revisarClasesProximas(hoy, horaActual, ahora, cfg) {
    if (!cfg.clasesProximas) return;

    const diaId = diaSemanaId(ahora);
    if (!diaId) return; // fin de semana, no hay clases

    const horarioDoc = await db.collection('horario').doc('maestro').get();
    if (!horarioDoc.exists) return;
    const clasesHoy = (horarioDoc.data()[diaId] || []).filter((c) => c.activo !== false);

    const [hAct, mAct] = horaActual.split(':').map(Number);
    const minutosAct = hAct * 60 + mAct;

    for (const clase of clasesHoy) {
        const [hCl, mCl] = clase.hora.split(':').map(Number);
        const minutosClase = hCl * 60 + mCl;
        // Ventana: X min antes (según config) hasta 4 min después de la hora
        // de inicio, con un pequeño margen para no depender del minuto exacto del cron.
        const enVentana = minutosAct >= (minutosClase - cfg.minutosAntesClase - 2) && minutosAct <= (minutosClase + 4);
        if (!enVentana) continue;

        const claveAviso = `${hoy}_${clase.id}`;
        const yaEnviado = await db.collection('avisos_clase_enviados').doc(claveAviso).get();
        if (yaEnviado.exists) continue;

        try {
            const tema = await obtenerTemaVigente(clase.grado, clase.grupo, hoy);
            let mensaje = `${clase.grado} ${clase.grupo} a las ${clase.hora}`;
            if (tema) mensaje += `\n📖 Tema: ${tema.tema}`;
            await notificar('📚 Próxima clase', mensaje, cfg);
            await db.collection('avisos_clase_enviados').doc(claveAviso).set({
                enviado: true,
                fecha: new Date().toISOString()
            });
            console.log(`Aviso de clase próxima enviado: ${clase.grado} ${clase.grupo} ${clase.hora}`);
        } catch (e) {
            console.error(`Error avisando de la clase ${clase.grado} ${clase.grupo}:`, e.message);
        }
    }
}

// Avisa cuando un tema de clase llega a su último día (fechaFin === hoy),
// para que no se te olvide registrar el siguiente. Se manda una vez al día
// (ventana 07:00–07:10) y queda marcado con avisoFinEnviado para no repetirse.
async function revisarTemasPorTerminar(hoy, horaActual, cfg) {
    if (!(horaActual >= '07:00' && horaActual <= '07:10')) return;

    const snap = await db.collection('temas').where('fechaFin', '==', hoy).get();
    for (const doc of snap.docs) {
        const t = doc.data();
        if (t.avisoFinEnviado === true) continue;
        try {
            const mensaje = `Hoy termina tu tema de ${t.grado} ${t.grupo}: "${t.tema}". No olvides registrar el siguiente en Temas de Clase.`;
            await notificar('📖 Tema por terminar', mensaje, cfg);
            await doc.ref.update({ avisoFinEnviado: true });
            console.log(`Aviso de tema por terminar enviado: ${t.grado} ${t.grupo}`);
        } catch (e) {
            console.error(`Error avisando fin de tema ${t.grado} ${t.grupo}:`, e.message);
        }
    }
}

async function main() {
    const ahora = ahoraCDMX();
    const hoy = `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}`;
    const horaActual = `${pad(ahora.getHours())}:${pad(ahora.getMinutes())}`;

    const manana = new Date(ahora);
    manana.setDate(manana.getDate() + 1);
    const mananaStr = `${manana.getFullYear()}-${pad(manana.getMonth() + 1)}-${pad(manana.getDate())}`;
    const diaId = diaSemanaId(ahora) || (ahora.getDay() === 0 ? 'domingo' : 'sabado');

    console.log(`Revisando recordatorios — hoy ${hoy} ${horaActual}`);

    const cfg = await obtenerConfigNotificaciones();

    await revisarRecordatoriosDeHoy(hoy, horaActual, cfg);
    await avisarRecordatoriosDeManana(horaActual, mananaStr, diaId, cfg);
    await revisarClasesProximas(hoy, horaActual, ahora, cfg);
    await revisarTemasPorTerminar(hoy, horaActual, cfg);

    console.log('Listo.');
}

main().catch((err) => {
    console.error('Error en check-recordatorios:', err);
    process.exit(1);
});
