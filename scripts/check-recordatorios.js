// scripts/check-recordatorios.js
//
// Este script corre en GitHub Actions (gratis).
// 1) Revisa Firestore buscando recordatorios pendientes de hoy.
// 2) Revisa el horario de clases y envía recordatorios 10 minutos antes.
// 3) Envía CORREO, TELEGRAM y PUSH (FCM) — SOLO por los medios y tipos de
//    aviso que estén activados en config/notificaciones (configurable
//    desde la app, en Administración > Mi Horario > Configurar recordatorios).
// 4) Marca los recordatorios como enviados para no repetirlos.
// 5) También avisa la noche anterior (hora y días configurables) sobre los
//    recordatorios y clases de "mañana".

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// ============================================================
// CONFIGURACIÓN
// ============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const CORREO_DESTINO = 'elprofechan@gmail.com';

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

// Configurar transporte de correo
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

// ============================================================
// CONSTANTES DEL HORARIO
// ============================================================
const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const DIAS_ESPANOL = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

// Configuración por defecto (si nunca se ha guardado nada desde la app,
// se comporta como antes: todo activado, aviso de "mañana" a las 20:00,
// todos los días).
const CONFIG_DEFAULT = {
    correo: true,
    telegram: true,
    push: true,
    clasesProximas: true,
    recordatoriosHoy: true,
    avisoManana: true,
    horaAvisoManana: '20:00',
    diasAvisoManana: DIAS_SEMANA.slice()
};

// ============================================================
// FUNCIONES DE UTILIDAD
// ============================================================
function pad(n) {
    return n.toString().padStart(2, '0');
}

function ahoraCDMX() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
}

function horaAMinutos(hora) {
    const [h, m] = hora.split(':').map(Number);
    return h * 60 + m;
}

function formatearFecha(fecha) {
    return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}`;
}

function formatearHora(fecha) {
    return `${pad(fecha.getHours())}:${pad(fecha.getMinutes())}`;
}

// ============================================================
// CONFIGURACIÓN DE NOTIFICACIONES (leída desde Firestore)
// ============================================================
async function obtenerConfigNotificaciones() {
    try {
        const doc = await db.collection('config').doc('notificaciones').get();
        if (!doc.exists) {
            console.log('ℹ️ No hay config/notificaciones guardada, usando valores por defecto');
            return { ...CONFIG_DEFAULT };
        }
        const d = doc.data();
        return {
            correo: d.correo !== false,
            telegram: d.telegram !== false,
            push: d.push !== false,
            clasesProximas: d.clasesProximas !== false,
            recordatoriosHoy: d.recordatoriosHoy !== false,
            avisoManana: d.avisoManana !== false,
            horaAvisoManana: d.horaAvisoManana || '20:00',
            diasAvisoManana: Array.isArray(d.diasAvisoManana) && d.diasAvisoManana.length > 0
                ? d.diasAvisoManana
                : DIAS_SEMANA.slice()
        };
    } catch (e) {
        console.error('❌ Error obteniendo config de notificaciones, usando valores por defecto:', e.message);
        return { ...CONFIG_DEFAULT };
    }
}

// ¿La hora actual cae dentro de la hora configurada para el aviso de mañana?
// (ventana de 1 hora, igual que antes, pero con la hora que elija el usuario)
function dentroDeVentanaAviso(horaActual, horaConfigurada) {
    const horaNum = parseInt(horaActual.split(':')[0]);
    const horaConfigNum = parseInt((horaConfigurada || '20:00').split(':')[0]);
    return horaNum === horaConfigNum;
}

// ============================================================
// FUNCIONES DE NOTIFICACIÓN
// ============================================================
async function enviarCorreo(asunto, mensaje) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
        console.warn('⚠️ Faltan GMAIL_USER / GMAIL_APP_PASSWORD');
        return false;
    }
    try {
        await transporter.sendMail({
            from: `"Asistente Escolar" <${process.env.GMAIL_USER}>`,
            to: CORREO_DESTINO,
            subject: asunto,
            text: mensaje
        });
        console.log(`📧 Correo enviado: ${asunto}`);
        return true;
    } catch (e) {
        console.error('❌ Error enviando correo:', e.message);
        return false;
    }
}

async function enviarTelegram(asunto, mensaje) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.warn('⚠️ Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
        return false;
    }
    try {
        const texto = `*${asunto}*\n${mensaje}`;
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' })
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.description || 'Error de Telegram');
        console.log(`📱 Telegram enviado: ${asunto}`);
        return true;
    } catch (e) {
        console.error('❌ Error enviando Telegram:', e.message);
        return false;
    }
}

async function obtenerTokens() {
    try {
        const snap = await db.collection('fcm_tokens').where('activo', '==', true).get();
        return snap.docs.map((d) => d.id);
    } catch (e) {
        console.error('❌ Error obteniendo tokens FCM:', e.message);
        return [];
    }
}

async function enviarPush(titulo, cuerpo) {
    try {
        const tokens = await obtenerTokens();
        if (tokens.length === 0) {
            console.log('📭 No hay tokens de push registrados');
            return false;
        }

        const respuesta = await messaging.sendEachForMulticast({
            tokens,
            notification: { title: titulo, body: cuerpo },
            webpush: {
                fcmOptions: { link: '/' },
                notification: {
                    icon: 'https://raw.githubusercontent.com/mke210/asistente-escolar/main/asistente-virtual.png',
                    badge: 'https://raw.githubusercontent.com/mke210/asistente-escolar/main/asistente-virtual.png',
                    vibrate: [200, 100, 200]
                }
            }
        });

        // Limpiar tokens inválidos
        const tokensInvalidos = [];
        respuesta.responses.forEach((r, i) => {
            if (!r.success) {
                const code = r.error && r.error.code;
                if (code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token') {
                    tokensInvalidos.push(tokens[i]);
                }
            }
        });

        for (const t of tokensInvalidos) {
            await db.collection('fcm_tokens').doc(t).delete();
        }

        console.log(`📲 Push enviado: ${respuesta.successCount} ok, ${respuesta.failureCount} fallidos`);
        return respuesta.successCount > 0;
    } catch (e) {
        console.error('❌ Error enviando push:', e.message);
        return false;
    }
}

// Envía por los medios que el usuario tenga activados en config/notificaciones.
// prioridad 'clase' o 'alta' habilita el push (si además está activado).
async function notificar(titulo, cuerpo, prioridad = 'normal', config) {
    if (config.correo) {
        await enviarCorreo(titulo, cuerpo);
    }
    if (config.telegram) {
        await enviarTelegram(titulo, cuerpo);
    }
    if ((prioridad === 'clase' || prioridad === 'alta') && config.push) {
        await enviarPush(titulo, cuerpo);
    }
}

// ============================================================
// FUNCIÓN: Verificar clases próximas
// ============================================================
async function verificarClasesProximas(config) {
    if (!config.clasesProximas) {
        console.log('⏭️ Aviso de clases próximas desactivado en configuración');
        return;
    }
    console.log('⏰ Verificando clases próximas...');

    try {
        // Obtener el horario del maestro
        const horarioDoc = await db.collection('horario').doc('maestro').get();
        if (!horarioDoc.exists) {
            console.log('ℹ️ No hay horario configurado en Firestore');
            return;
        }

        const horario = horarioDoc.data();
        const ahora = ahoraCDMX();
        const diaSemana = ahora.getDay();
        const diaNombre = DIAS_SEMANA[diaSemana];
        const horaActual = formatearHora(ahora);
        const fechaHoy = formatearFecha(ahora);

        // Verificar si el día actual tiene clases
        const clasesHoy = horario[diaNombre] || [];
        if (clasesHoy.length === 0) {
            console.log(`📅 Hoy ${DIAS_ESPANOL[diaSemana]} no hay clases`);
            return;
        }

        // Verificar cada clase
        let notificacionesEnviadas = 0;
        for (const clase of clasesHoy) {
            const deberiaNotificar = deberiaNotificarClase(clase.hora, horaActual);
            if (deberiaNotificar) {
                const enviado = await enviarRecordatorioClase(clase, DIAS_ESPANOL[diaSemana], fechaHoy, config);
                if (enviado) notificacionesEnviadas++;
            }
        }

        if (notificacionesEnviadas > 0) {
            console.log(`✅ Enviadas ${notificacionesEnviadas} notificaciones de clases`);
        } else {
            console.log('📭 No hay clases próximas para notificar');
        }

    } catch (error) {
        console.error('❌ Error verificando clases:', error);
    }
}

function deberiaNotificarClase(horaInicio, horaActual) {
    const minutosInicio = horaAMinutos(horaInicio);
    const minutosActual = horaAMinutos(horaActual);

    // La diferencia en minutos
    const diferencia = minutosInicio - minutosActual;

    // Notificar si la clase comienza en 10 minutos o menos
    // También notificar si está en curso y pasaron menos de 3 minutos
    const estaProxima = diferencia > 0 && diferencia <= 10;
    const estaEnCurso = diferencia < 0 && diferencia >= -3;

    return estaProxima || estaEnCurso;
}

async function enviarRecordatorioClase(clase, dia, fecha, config) {
    const { grupo, hora, horaFin, modulos } = clase;

    // ID único para evitar duplicados
    const recordatorioId = `clase_${fecha}_${grupo}_${hora}`;

    try {
        // Revisar si ya se envió
        const notifDoc = await db.collection('notificaciones_enviadas').doc(recordatorioId).get();
        if (notifDoc.exists) {
            console.log(`⏭️ Ya se notificó: ${grupo} a las ${hora}`);
            return false;
        }

        // Crear mensaje
        let titulo = `📚 ${grupo}`;
        let cuerpo = `${dia} de ${hora} a ${horaFin} - ${modulos} módulo${modulos > 1 ? 's' : ''}`;

        console.log(`🔔 Enviando recordatorio de clase: ${titulo}`);

        // Enviar notificación
        await notificar(titulo, cuerpo, 'clase', config);

        // Registrar envío
        await db.collection('notificaciones_enviadas').doc(recordatorioId).set({
            tipo: 'clase',
            grupo,
            hora,
            fecha,
            enviado: new Date().toISOString()
        });

        return true;
    } catch (error) {
        console.error(`❌ Error enviando recordatorio para ${grupo}:`, error.message);
        return false;
    }
}

// ============================================================
// FUNCIÓN: Revisar recordatorios de hoy
// ============================================================
async function revisarRecordatoriosDeHoy(hoy, horaActual, config) {
    if (!config.recordatoriosHoy) {
        console.log('⏭️ Recordatorios de hoy desactivados en configuración');
        return;
    }
    console.log('📋 Revisando recordatorios de hoy...');

    try {
        const snap = await db.collection('recordatorios')
            .where('enviado', '==', false)
            .where('fecha', '==', hoy)
            .get();

        let procesados = 0;
        for (const doc of snap.docs) {
            const r = doc.data();
            let debeNotificar = false;

            if (r.hora) {
                const minutosRec = horaAMinutos(r.hora);
                const minutosAct = horaAMinutos(horaActual);
                // Ventana de 15 min antes a 5 min después
                if (minutosAct >= minutosRec - 15 && minutosAct <= minutosRec + 5) {
                    debeNotificar = true;
                }
            } else {
                // Sin hora específica: se manda entre 8:00 y 9:00
                const horaNum = parseInt(horaActual.split(':')[0]);
                if (horaNum >= 8 && horaNum <= 9) {
                    debeNotificar = true;
                }
            }

            if (debeNotificar) {
                try {
                    const mensaje = `${r.titulo}${r.descripcion ? ' — ' + r.descripcion : ''}${r.hora ? ' (⏰ ' + r.hora + ')' : ''}`;
                    await notificar('🔔 Recordatorio', mensaje, 'normal', config);
                    await doc.ref.update({
                        enviado: true,
                        fechaEnvio: new Date().toISOString()
                    });
                    console.log(`✅ Recordatorio enviado: ${r.titulo}`);
                    procesados++;
                } catch (e) {
                    console.error(`❌ Error en recordatorio "${r.titulo}":`, e.message);
                }
            }
        }

        if (procesados > 0) {
            console.log(`📨 Enviados ${procesados} recordatorios de hoy`);
        }
    } catch (error) {
        console.error('❌ Error revisando recordatorios de hoy:', error);
    }
}

// ============================================================
// FUNCIÓN: Avisar recordatorios de mañana
// ============================================================
async function avisarRecordatoriosDeManana(horaActual, mananaStr, diaNombreHoy, config) {
    if (!config.avisoManana) return;
    if (!config.diasAvisoManana.includes(diaNombreHoy)) return;
    if (!dentroDeVentanaAviso(horaActual, config.horaAvisoManana)) return;

    console.log('📅 Revisando recordatorios para mañana...');

    try {
        const snap = await db.collection('recordatorios')
            .where('enviado', '==', false)
            .where('fecha', '==', mananaStr)
            .get();

        let procesados = 0;
        for (const doc of snap.docs) {
            const r = doc.data();
            if (r.avisoPrevioEnviado === true) continue;

            const mensaje = `Mañana: ${r.titulo}${r.hora ? ' (⏰ ' + r.hora + ')' : ''}`;
            await notificar('📅 Recordatorio para mañana', mensaje, 'normal', config);
            await doc.ref.update({ avisoPrevioEnviado: true });
            console.log(`✅ Aviso previo enviado: ${r.titulo}`);
            procesados++;
        }

        if (procesados > 0) {
            console.log(`📨 Enviados ${procesados} avisos para mañana`);
        }
    } catch (error) {
        console.error('❌ Error revisando recordatorios de mañana:', error);
    }
}

// ============================================================
// FUNCIÓN: Avisar clases de mañana
// ============================================================
async function avisarClasesManana(horaActual, diaNombreHoy, config) {
    if (!config.avisoManana) return;
    if (!config.diasAvisoManana.includes(diaNombreHoy)) return;
    if (!dentroDeVentanaAviso(horaActual, config.horaAvisoManana)) return;

    console.log('📅 Revisando clases para mañana...');

    try {
        const recordatorioId = `avisoClasesManana_${formatearFecha(ahoraCDMX())}`;
        const yaEnviado = await db.collection('notificaciones_enviadas').doc(recordatorioId).get();
        if (yaEnviado.exists) {
            console.log('⏭️ El aviso de clases de mañana ya se envió hoy');
            return;
        }

        const horarioDoc = await db.collection('horario').doc('maestro').get();
        if (!horarioDoc.exists) return;

        const horario = horarioDoc.data();
        const manana = new Date(ahoraCDMX());
        manana.setDate(manana.getDate() + 1);
        const diaSemana = manana.getDay();
        const diaNombre = DIAS_SEMANA[diaSemana];
        const clasesManana = horario[diaNombre] || [];

        if (clasesManana.length === 0) {
            console.log(`📅 Mañana ${DIAS_ESPANOL[diaSemana]} no hay clases`);
            return;
        }

        // Enviar resumen de clases de mañana
        let mensaje = `📚 Clases de mañana (${DIAS_ESPANOL[diaSemana]}):\n\n`;
        clasesManana.forEach(clase => {
            mensaje += `• ${clase.grupo}: ${clase.hora} a ${clase.horaFin} (${clase.modulos} módulo${clase.modulos > 1 ? 's' : ''})\n`;
        });

        await notificar('📅 Clases de mañana', mensaje, 'normal', config);

        // Registrar envío para no repetirlo el resto de la ventana de la hora
        await db.collection('notificaciones_enviadas').doc(recordatorioId).set({
            tipo: 'avisoClasesManana',
            enviado: new Date().toISOString()
        });

        console.log(`✅ Aviso de clases de mañana enviado`);

    } catch (error) {
        console.error('❌ Error avisando clases de mañana:', error);
    }
}

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================
async function main() {
    const ahora = ahoraCDMX();
    const hoy = formatearFecha(ahora);
    const horaActual = formatearHora(ahora);
    const diaNombreHoy = DIAS_SEMANA[ahora.getDay()];

    const manana = new Date(ahora);
    manana.setDate(manana.getDate() + 1);
    const mananaStr = formatearFecha(manana);

    const config = await obtenerConfigNotificaciones();

    console.log(`🔄 Revisando recordatorios — ${hoy} ${horaActual} (CDMX)`);
    console.log(`⚙️ Config: correo=${config.correo} telegram=${config.telegram} push=${config.push} clasesProximas=${config.clasesProximas} recordatoriosHoy=${config.recordatoriosHoy} avisoManana=${config.avisoManana} (${config.horaAvisoManana}, días: ${config.diasAvisoManana.join(', ')})`);
    console.log('==================================================');

    // 1. Verificar clases próximas
    await verificarClasesProximas(config);

    // 2. Revisar recordatorios de hoy
    await revisarRecordatoriosDeHoy(hoy, horaActual, config);

    // 3. Avisar recordatorios de mañana
    await avisarRecordatoriosDeManana(horaActual, mananaStr, diaNombreHoy, config);

    // 4. Avisar clases de mañana
    await avisarClasesManana(horaActual, diaNombreHoy, config);

    console.log('==================================================');
    console.log('✅ Proceso completado.');
}

// ============================================================
// EJECUTAR
// ============================================================
main().catch((err) => {
    console.error('❌ Error en check-recordatorios:', err);
    process.exit(1);
});