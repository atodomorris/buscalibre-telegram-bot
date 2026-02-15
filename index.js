const http = require("http");
const puppeteer = require("puppeteer");
const axios = require("axios");
const qs = require("qs");
const mongoose = require("mongoose");

// ---------------------------
// Configuración
// ---------------------------
const CLOUD_NAME = "dvye0cje6";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const PORT = Number(process.env.PORT || 10000);
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
const CHECK_INTERVAL_MS = Math.max(1, CHECK_INTERVAL_MINUTES) * 60 * 1000;
const TARGET_URL = "https://www.buscalibre.cl";

let lastRunAt = null;
let lastStatus = "starting";
let lastError = null;
let isRunning = false;
let intervalRef;

// Diagnóstico
console.log("🔍 --- REVISIÓN VARIABLES ---");
console.log(`1. TOKEN: ${TELEGRAM_TOKEN ? "✅" : "❌"}`);
console.log(`2. CHAT_ID: ${TELEGRAM_CHAT_ID ? "✅" : "❌"}`);
console.log(`3. MONGO: ${MONGO_URI ? "✅" : "❌"}`);
console.log(`4. PORT: ${PORT}`);
console.log(`5. CHECK_INTERVAL_MINUTES: ${CHECK_INTERVAL_MINUTES}`);

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !MONGO_URI) {
  console.error("❌ Faltan variables de entorno obligatorias.");
  process.exit(1);
}

// ---------------------------
// Base de Datos (Modelo Estándar)
// Healthcheck server (Render + UptimeRobot)
// ---------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const payload = {
      ok: lastStatus !== "error",
      status: lastStatus,
      isRunning,
      lastRunAt,
      lastError,
      uptimeSec: Math.round(process.uptime())
    };
    res.writeHead(payload.ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Buscalibre bot alive");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Healthcheck activo en puerto ${PORT}`);
});

// ---------------------------
// Base de Datos
// ---------------------------
const promoSchema = new mongoose.Schema({
  idImagen: String,
  textoCintillo: String,
  textoOriginalBanner: String, // La identidad real de la promo
  textoOriginalBanner: String,
  link: String,
  imagenFusionada: String,
  fecha: { type: Date, default: Date.now }
});

const PromoModel = mongoose.model("PromoBuscalibre", promoSchema);

async function connectToMongo() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    maxPoolSize: 5
  });
}

mongoose.connection.on("connected", () => {
  console.log("✅ Mongo conectado");
});
mongoose.connection.on("disconnected", () => {
  console.log("⚠️ Mongo desconectado");
});
mongoose.connection.on("error", (err) => {
  console.error("❌ Error Mongo:", err.message);
});

// ---------------------------
// Funciones
// ---------------------------
function crearImagenFusionada(urlBase, urlDetalle) {
  if (!urlBase || !urlDetalle) return null;
  const urlDetalleB64 = Buffer.from(urlDetalle).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/l_fetch:${urlDetalleB64}/fl_layer_apply,g_center/q_auto,f_jpg/${urlBase}`;

  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/l_fetch:${Buffer.from(urlDetalle)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}/fl_layer_apply,g_center/q_auto,f_jpg/${urlBase}`;
}

async function enviarTelegram(promo, tipoMensaje) {
  let mensaje = `🚨 <b>NUEVA PROMO DETECTADA!</b>\n\n`;
  let mensaje = "🚨 <b>NUEVA PROMO DETECTADA!</b>\n\n";
  mensaje += `<b>${promo.textoCintillo || "Revisa la web"}</b>`;

  if (tipoMensaje === "FULL" && promo.imagenFusionada) {
    mensaje += `<a href="${promo.imagenFusionada}">&#8205;</a>`;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, qs.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mensaje,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "🚀 Ver Ofertas", url: promo.link }]] })
    }));
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      qs.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "🚀 Ver Ofertas", url: promo.link }]]
        })
      }),
      {
        timeout: 20000,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );

    console.log(`✅ Enviado: ${tipoMensaje}`);
  } catch (e) { console.error("❌ Error Telegram:", e.message); }
  } catch (e) {
    console.error("❌ Error Telegram:", e.message);
  }
}

// ---------------------------
// Lógica Principal
// ---------------------------
async function buscarPromo(esPrueba = false) {
  if (isRunning) {
    console.log("⏳ Ejecución anterior aún en progreso, se omite esta ronda.");
    return;
  }

  isRunning = true;
  lastStatus = "running";
  lastError = null;
  console.log("🔎 Buscando...", new Date().toLocaleString());

  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
  });
  let browser;

  try {
    await connectToMongo();

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process"
      ]
    });

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => ['font', 'stylesheet'].includes(r.resourceType()) ? r.abort() : r.continue());
    
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded", timeout: 60000 });
    page.on("request", (request) => {
      const type = request.resourceType();
      if (["font", "stylesheet"].includes(type)) {
        request.abort();
        return;
      }
      request.continue();
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    const datos = await page.evaluate(() => {
      const aviso = document.querySelector(".avisoTop");
      let txt = aviso ? aviso.innerText.replace(/Ver más/gi, "").trim() : "";
      let link = aviso ? aviso.querySelector("a")?.href : null;
      
      const txt = aviso ? aviso.innerText.replace(/Ver más/gi, "").trim() : "";
      const link = aviso ? aviso.querySelector("a")?.href : null;

      const img = document.querySelector("section#portadaHome img[alt]");
      const bg = img ? img.closest("div[style*='background-image']")?.getAttribute('style')?.match(/url\(\s*['"]?(.*?)['"]?\s*\)/)?.[1] : "";
      
      const bg = img
        ? img
            .closest("div[style*='background-image']")
            ?.getAttribute("style")
            ?.match(/url\(\s*['\"]?(.*?)['\"]?\s*\)/)?.[1]
        : "";

      return {
        pngUrl: img && img.src.startsWith('http') ? img.src : "",
        pngUrl: img && img.src.startsWith("http") ? img.src : "",
        jpgUrl: bg || "",
        texto: txt,
        link: link || img?.closest("a")?.href || "https://www.buscalibre.cl"
      };
    });

    const promoActual = {
      idImagen: datos.pngUrl,
      textoCintillo: datos.texto,
      link: datos.link,
      imagenFusionada: crearImagenFusionada(datos.jpgUrl, datos.pngUrl)
    };

    const ultimaDB = await PromoModel.findOne();
    const ultimaDB = await PromoModel.findOne().sort({ fecha: -1 });

    if (esPrueba) {
      await enviarTelegram(promoActual, "FULL");
    }
    // --- AQUÍ OCURRE LA MAGIA DEL REINICIO ---
    else if (!ultimaDB) {
      console.log("🆕 Inicio Limpio. Guardando Original.");
      // Guardamos la promo actual como la "Original"
    } else if (!ultimaDB) {
      console.log("🆕 Inicio limpio. Guardando promo base.");
      await PromoModel.create({ ...promoActual, textoOriginalBanner: promoActual.textoCintillo });
    }
    else {
    } else {
      const cambioImg = promoActual.idImagen !== ultimaDB.idImagen;
      const cambioTxt = promoActual.textoCintillo !== ultimaDB.textoCintillo;
      const hayVisual = promoActual.idImagen && promoActual.idImagen.length > 10;

      if (cambioImg) {
        if (hayVisual) {
          console.log("🎨 Cambio Banner -> FULL");
          console.log("🎨 Cambio banner -> FULL");
          await enviarTelegram(promoActual, "FULL");
          await PromoModel.updateOne({}, { ...promoActual, textoOriginalBanner: promoActual.textoCintillo });
          await PromoModel.findByIdAndUpdate(
            ultimaDB._id,
            { ...promoActual, textoOriginalBanner: promoActual.textoCintillo, fecha: new Date() },
            { new: true }
          );
        } else {
          console.log("⚠️ Sin Banner -> TEXTO");
          console.log("⚠️ Sin banner -> TEXTO");
          await enviarTelegram(promoActual, "TEXT_ONLY");
          await PromoModel.updateOne({}, promoActual);
          await PromoModel.findByIdAndUpdate(ultimaDB._id, { ...promoActual, fecha: new Date() }, { new: true });
        }
      } 
      else if (cambioTxt) {
        // LÓGICA DE RETORNO
      } else if (cambioTxt) {
        if (promoActual.textoCintillo === ultimaDB.textoOriginalBanner) {
           console.log("🔄 Retorno a Original -> FULL");
           await enviarTelegram(promoActual, "FULL");
          console.log("🔄 Retorno a original -> FULL");
          await enviarTelegram(promoActual, "FULL");
        } else {
           console.log("⚡ Relámpago -> TEXTO");
           await enviarTelegram(promoActual, "TEXT_ONLY");
          console.log("⚡ Relámpago -> TEXTO");
          await enviarTelegram(promoActual, "TEXT_ONLY");
        }
        await PromoModel.updateOne({}, { $set: { textoCintillo: promoActual.textoCintillo, link: promoActual.link } });
      } 
      else {

        await PromoModel.findByIdAndUpdate(
          ultimaDB._id,
          { textoCintillo: promoActual.textoCintillo, link: promoActual.link, fecha: new Date() },
          { new: true }
        );
      } else {
        console.log("💤 Sin cambios");
      }
    }

  } catch (e) { console.error(e); } finally { if (browser) await browser.close(); }
    lastRunAt = new Date().toISOString();
    lastStatus = "ok";
  } catch (e) {
    lastStatus = "error";
    lastError = e.message;
    console.error("❌ Error en ejecución:", e);
  } finally {
    isRunning = false;
    if (browser) {
      await browser.close();
    }
  }
}

buscarPromo(false); 
setInterval(() => buscarPromo(false), 3600000);
function startScheduler() {
  buscarPromo(false).catch((err) => {
    console.error("❌ Error en ejecución inicial:", err);
  });

  intervalRef = setInterval(() => {
    buscarPromo(false).catch((err) => {
      console.error("❌ Error en ejecución programada:", err);
    });
  }, CHECK_INTERVAL_MS);

  console.log(`⏱️ Scheduler iniciado cada ${CHECK_INTERVAL_MINUTES} minuto(s).`);
}

async function shutdown(signal) {
  console.log(`\n🛑 Recibido ${signal}, cerrando...`);

  if (intervalRef) {
    clearInterval(intervalRef);
  }

  try {
    await mongoose.connection.close();
  } catch (e) {
    console.error("Error cerrando Mongo:", e.message);
  }

  server.close(() => {
    console.log("👋 Proceso finalizado correctamente.");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startScheduler();
