const puppeteer = require("puppeteer");
const axios = require("axios");
const qs = require("qs");
const mongoose = require("mongoose");

// ---------------------------
// Configuración y Variables
// ---------------------------
const CLOUD_NAME = "dvye0cje6";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI; // <--- NUEVA VARIABLE OBLIGATORIA

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !MONGO_URI) {
  console.error("❌ ERROR: Faltan variables de entorno (Telegram o Mongo).");
  process.exit(1);
}

// ---------------------------
// Configuración Mongoose (Base de Datos)
// ---------------------------
const promoSchema = new mongoose.Schema({
  idImagen: String,
  textoCintillo: String,
  link: String,
  imagenFusionada: String,
  fecha: { type: Date, default: Date.now }
});

const PromoModel = mongoose.model("PromoBuscalibre", promoSchema);

// ---------------------------
// 1. Fusión de Imágenes
// ---------------------------
function crearImagenFusionada(urlBase, urlDetalle) {
  if (!urlBase) return null;
  if (!urlDetalle) return urlBase;

  const urlDetalleB64 = Buffer.from(urlDetalle).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/` +
         `l_fetch:${urlDetalleB64}/fl_layer_apply,g_center/` +
         `q_auto,f_jpg/` +
         urlBase;
}

// ---------------------------
// 2. Enviar a Telegram
// ---------------------------
async function enviarTelegram(promo, tipoMensaje) {
  let mensaje = `🚨 <b>NUEVA PROMO DETECTADA!</b>\n\n`;

  const textoCintillo = promo.textoCintillo || "Revisa las ofertas en la web";
  mensaje += `<b>${textoCintillo}</b>`;

  if (tipoMensaje === "FULL" && promo.imagenFusionada) {
    mensaje += `<a href="${promo.imagenFusionada}">&#8205;</a>`;
  }

  const teclado = {
    inline_keyboard: [[
      { text: "🚀 Ver Ofertas", url: promo.link }
    ]]
  };

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      qs.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        reply_markup: JSON.stringify(teclado)
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    console.log("✅ Mensaje enviado a Telegram.");
  } catch (error) {
    console.error("❌ Error enviando a Telegram:", error.message);
  }
}

// ---------------------------
// 3. Scraping y Lógica Principal
// ---------------------------
async function buscarPromo(esPrueba = false) {
  console.log("🔎 Buscando cambios (Modo Mongo)...", new Date().toLocaleString());

  // Conectar a Mongo si no estamos conectados
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI);
    console.log("💾 Conectado a MongoDB.");
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", 
      "--disable-setuid-sandbox", 
      "--disable-dev-shm-usage",
      "--single-process"
    ]
  });

  try {
    const page = await browser.newPage();
    // Bloqueo de recursos para velocidad
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded", timeout: 30000 });

    // --- SCRAPING ---
    const datosScraped = await page.evaluate(() => {
      const avisoTop = document.querySelector(".avisoTop");
      let texto = "";
      let linkCintillo = null;

      if (avisoTop) {
        texto = avisoTop.innerText || "";
        texto = texto.replace(/Ver más/gi, "").trim();
        const enlace = avisoTop.querySelector("a");
        if (enlace) linkCintillo = enlace.href;
      }

      const imgFrontal = document.querySelector("section#portadaHome img[alt]");
      let bgUrl = null;
      if (imgFrontal) {
        const contenedor = imgFrontal.closest("div[style*='background-image']");
        if (contenedor) {
          const style = contenedor.getAttribute('style');
          const match = style.match(/url\(\s*['"]?(.*?)['"]?\s*\)/);
          if (match) bgUrl = match[1];
        }
      }
      const linkBanner = imgFrontal?.closest("a")?.href;

      return {
        pngUrl: imgFrontal?.src || "",
        jpgUrl: bgUrl || "",
        textoCintillo: texto,
        link: linkCintillo || linkBanner || "https://www.buscalibre.cl"
      };
    });

    const imagenFusionada = crearImagenFusionada(datosScraped.jpgUrl, datosScraped.pngUrl);

    const promoActual = {
      idImagen: datosScraped.pngUrl,
      textoCintillo: datosScraped.textoCintillo,
      link: datosScraped.link,
      imagenFusionada: imagenFusionada
    };

    // --- LÓGICA DE BASE DE DATOS ---
    
    // 1. Buscamos la última promo guardada en la DB
    const ultimaPromoDB = await PromoModel.findOne();

    // MODO PRUEBA
    if (esPrueba) {
      console.log("🧪 Modo Prueba: Enviando mensaje forzado.");
      await enviarTelegram(promoActual, "FULL");
    }
    // PRIMERA VEZ (Base de datos vacía)
    else if (!ultimaPromoDB) {
      console.log("🆕 Base de datos vacía. Guardando estado inicial (Silent Start).");
      // Creamos el primer registro sin notificar para evitar spam al deployar
      await PromoModel.create(promoActual);
    }
    // COMPARACIÓN
    else {
      // A. Cambio de Banner
      if (promoActual.idImagen !== ultimaPromoDB.idImagen) {
        console.log("🎨 Cambio de Banner -> Enviando FULL");
        await enviarTelegram(promoActual, "FULL");
        // Actualizamos el registro único en la DB
        await PromoModel.updateOne({}, promoActual);
      }
      // B. Cambio de Texto
      else if (promoActual.textoCintillo !== ultimaPromoDB.textoCintillo) {
         if (promoActual.textoCintillo && promoActual.textoCintillo.length > 2) {
            console.log("⚡ Cambio de Cintillo -> Enviando TEXTO");
            await enviarTelegram(promoActual, "TEXT_ONLY");
            // Actualizamos DB
            await PromoModel.updateOne({}, promoActual);
         }
      } 
      else {
        console.log("💤 Sin cambios relevantes.");
      }
    }

  } catch (error) {
    console.error("Error general:", error);
  } finally {
    if (browser) await browser.close();
    // No cerramos conexión a Mongo para mantenerla viva en el loop
  }
}

// ---------------------------
// Ejecución
// ---------------------------
buscarPromo(false); // Inicia en modo monitor

// Intervalo cada 1 hora (3600000 ms)
setInterval(() => buscarPromo(false), 3600000);
