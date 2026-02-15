const http = require("http");
const puppeteer = require("puppeteer");
const axios = require("axios");
const qs = require("qs");
const mongoose = require("mongoose");
const { execFileSync } = require("child_process");
const path = require("path");

// ---------------------------
// Configuración
// ---------------------------
const CLOUD_NAME = "dvye0cje6";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHATID || process.env.CHAT_ID || "";
const MONGO_URI = process.env.MONGO_URI;
const PORT = Number(process.env.PORT || 10000);
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
const CHECK_INTERVAL_MS = Math.max(1, CHECK_INTERVAL_MINUTES) * 60 * 1000;

let lastStatus = "starting";
let lastRunAt = null;
let lastError = null;
let isRunning = false;

console.log("🔍 --- REVISIÓN VARIABLES ---");
console.log(`1. TOKEN: ${TELEGRAM_TOKEN ? "✅" : "❌"}`);
console.log(`2. CHAT_ID: ${TELEGRAM_CHAT_ID ? "✅" : "❌"}`);
console.log(`3. MONGO: ${MONGO_URI ? "✅" : "❌"}`);
console.log(`4. PORT: ${PORT}`);
console.log(`5. CHECK_INTERVAL_MINUTES: ${CHECK_INTERVAL_MINUTES}`);

const missingVars = [];
if (!TELEGRAM_TOKEN) missingVars.push("TELEGRAM_TOKEN");
if (!TELEGRAM_CHAT_ID) missingVars.push("TELEGRAM_CHAT_ID");
if (!MONGO_URI) missingVars.push("MONGO_URI");

if (missingVars.length) {
  console.warn(`⚠️ Faltan variables: ${missingVars.join(", ")}`);
  console.warn("⚠️ El servicio seguirá arriba, pero el bot no podrá operar al 100%.");
}

// ---------------------------
// Healthcheck para Render/UptimeRobot
// ---------------------------
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      const payload = {
        ok: true,
        service: "up",
        botStatus: lastStatus,
        isRunning,
        lastRunAt,
        lastError
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Healthcheck activo en puerto ${PORT}`);
  });

// ---------------------------
// Base de Datos (modelo original)
// ---------------------------
const promoSchema = new mongoose.Schema({
  idImagen: String,
  textoCintillo: String,
  textoOriginalBanner: String,
  link: String,
  imagenFusionada: String,
  fecha: { type: Date, default: Date.now }
});

const PromoModel = mongoose.model("PromoBuscalibre", promoSchema);

function crearImagenFusionada(urlBase, urlDetalle) {
  if (!urlBase || !urlDetalle) return null;
  const detalle = Buffer.from(urlDetalle)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/l_fetch:${detalle}/fl_layer_apply,g_center/q_auto,f_jpg/${urlBase}`;
}

async function enviarTelegram(promo, tipoMensaje) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram no configurado (falta TELEGRAM_TOKEN o TELEGRAM_CHAT_ID). Se omite envío.");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      qs.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text:
          "🚨 <b>NUEVA PROMO DETECTADA!</b>\n\n" +
          `<b>${promo.textoCintillo || "Revisa la web"}</b>` +
          (tipoMensaje === "FULL" && promo.imagenFusionada
            ? `<a href="${promo.imagenFusionada}">&#8205;</a>`
            : ""),
        parse_mode: "HTML",
        disable_web_page_preview: false,
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "🚀 Ver Ofertas", url: promo.link }]]
        })
      })
    );
    console.log(`✅ Enviado: ${tipoMensaje}`);
  } catch (e) {
    console.error("❌ Error Telegram:", e.message);
  }
}

async function lanzarBrowserConAutoInstalacion() {
  const launchOptions = {
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
  };

  try {
    return await puppeteer.launch(launchOptions);
  } catch (e) {
    const msg = String(e?.message || "");
    if (!msg.includes("Could not find Chrome")) {
      throw e;
    }

    console.log("🛠️ Chrome no encontrado. Intentando instalación automática...");
    const cliPath = path.join(__dirname, "node_modules", "puppeteer", "lib", "cjs", "puppeteer", "node", "cli.js");
    execFileSync(process.execPath, [cliPath, "browsers", "install", "chrome"], { stdio: "inherit" });
    return await puppeteer.launch(launchOptions);
  }
}

async function buscarPromo(esPrueba = false) {
  if (isRunning) {
    console.log("⏳ Ya hay una ejecución en curso, se omite esta ronda.");
    return;
  }

  isRunning = true;
  lastStatus = "running";
  lastError = null;

  console.log("🔎 Buscando...", new Date().toLocaleString());

  let browser;

  try {
    if (!MONGO_URI) {
      throw new Error("Falta MONGO_URI");
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI);
    }

    browser = await lanzarBrowserConAutoInstalacion();

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => (["font", "stylesheet"].includes(r.resourceType()) ? r.abort() : r.continue()));

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded", timeout: 60000 });

    const datos = await page.evaluate(() => {
      const aviso = document.querySelector(".avisoTop");
      const txt = aviso ? aviso.innerText.replace(/Ver más/gi, "").trim() : "";
      const link = aviso ? aviso.querySelector("a")?.href : null;

      const img = document.querySelector("section#portadaHome img[alt]");
      const bg = img
        ? img
            .closest("div[style*='background-image']")
            ?.getAttribute("style")
            ?.match(/url\(\s*['\"]?(.*?)['\"]?\s*\)/)?.[1]
        : "";

      return {
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

    if (esPrueba) {
      await enviarTelegram(promoActual, "FULL");
    } else if (!ultimaDB) {
      console.log("🆕 Inicio limpio. Guardando original.");
      await PromoModel.create({ ...promoActual, textoOriginalBanner: promoActual.textoCintillo });
    } else {
      const cambioImg = promoActual.idImagen !== ultimaDB.idImagen;
      const cambioTxt = promoActual.textoCintillo !== ultimaDB.textoCintillo;
      const hayVisual = promoActual.idImagen && promoActual.idImagen.length > 10;

      if (cambioImg) {
        if (hayVisual) {
          console.log("🎨 Cambio Banner -> FULL");
          await enviarTelegram(promoActual, "FULL");
          await PromoModel.updateOne({}, { ...promoActual, textoOriginalBanner: promoActual.textoCintillo });
        } else {
          console.log("⚠️ Sin Banner -> TEXTO");
          await enviarTelegram(promoActual, "TEXT_ONLY");
          await PromoModel.updateOne({}, promoActual);
        }
      } else if (cambioTxt) {
        if (promoActual.textoCintillo === ultimaDB.textoOriginalBanner) {
          console.log("🔄 Retorno a Original -> FULL");
          await enviarTelegram(promoActual, "FULL");
        } else {
          console.log("⚡ Relámpago -> TEXTO");
          await enviarTelegram(promoActual, "TEXT_ONLY");
        }
        await PromoModel.updateOne({}, { $set: { textoCintillo: promoActual.textoCintillo, link: promoActual.link } });
      } else {
        console.log("💤 Sin cambios");
      }
    }

    lastStatus = "ok";
    lastRunAt = new Date().toISOString();
  } catch (e) {
    lastStatus = "error";
    lastError = e.message;
    console.error("❌ Error general:", e.message);
  } finally {
    isRunning = false;
    if (browser) await browser.close();
  }
}

buscarPromo(false);
setInterval(() => buscarPromo(false), CHECK_INTERVAL_MS);
