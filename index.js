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

// Diagnóstico
console.log("🔍 --- REVISIÓN VARIABLES ---");
console.log(`1. TOKEN: ${TELEGRAM_TOKEN ? "✅" : "❌"}`);
console.log(`2. CHAT_ID: ${TELEGRAM_CHAT_ID ? "✅" : "❌"}`);
console.log(`3. MONGO: ${MONGO_URI ? "✅" : "❌"}`);

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !MONGO_URI) {
  process.exit(1);
}

// ---------------------------
// Base de Datos (Modelo Estándar)
// ---------------------------
const promoSchema = new mongoose.Schema({
  idImagen: String,
  textoCintillo: String,
  textoOriginalBanner: String, // La identidad real de la promo
  link: String,
  imagenFusionada: String,
  fecha: { type: Date, default: Date.now }
});

const PromoModel = mongoose.model("PromoBuscalibre", promoSchema);

// ---------------------------
// Funciones
// ---------------------------
function crearImagenFusionada(urlBase, urlDetalle) {
  if (!urlBase || !urlDetalle) return null;
  const urlDetalleB64 = Buffer.from(urlDetalle).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/l_fetch:${urlDetalleB64}/fl_layer_apply,g_center/q_auto,f_jpg/${urlBase}`;
}

async function enviarTelegram(promo, tipoMensaje) {
  let mensaje = `🚨 <b>NUEVA PROMO DETECTADA!</b>\n\n`;
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
    console.log(`✅ Enviado: ${tipoMensaje}`);
  } catch (e) { console.error("❌ Error Telegram:", e.message); }
}

// ---------------------------
// Lógica Principal
// ---------------------------
async function buscarPromo(esPrueba = false) {
  console.log("🔎 Buscando...", new Date().toLocaleString());

  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
  });

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => ['font', 'stylesheet'].includes(r.resourceType()) ? r.abort() : r.continue());
    
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded", timeout: 60000 });

    const datos = await page.evaluate(() => {
      const aviso = document.querySelector(".avisoTop");
      let txt = aviso ? aviso.innerText.replace(/Ver más/gi, "").trim() : "";
      let link = aviso ? aviso.querySelector("a")?.href : null;
      
      const img = document.querySelector("section#portadaHome img[alt]");
      const bg = img ? img.closest("div[style*='background-image']")?.getAttribute('style')?.match(/url\(\s*['"]?(.*?)['"]?\s*\)/)?.[1] : "";
      
      return {
        pngUrl: img && img.src.startsWith('http') ? img.src : "",
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
    }
    // --- AQUÍ OCURRE LA MAGIA DEL REINICIO ---
    else if (!ultimaDB) {
      console.log("🆕 Inicio Limpio. Guardando Original.");
      // Guardamos la promo actual como la "Original"
      await PromoModel.create({ ...promoActual, textoOriginalBanner: promoActual.textoCintillo });
    }
    else {
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
      } 
      else if (cambioTxt) {
        // LÓGICA DE RETORNO
        if (promoActual.textoCintillo === ultimaDB.textoOriginalBanner) {
           console.log("🔄 Retorno a Original -> FULL");
           await enviarTelegram(promoActual, "FULL");
        } else {
           console.log("⚡ Relámpago -> TEXTO");
           await enviarTelegram(promoActual, "TEXT_ONLY");
        }
        await PromoModel.updateOne({}, { $set: { textoCintillo: promoActual.textoCintillo, link: promoActual.link } });
      } 
      else {
        console.log("💤 Sin cambios");
      }
    }

  } catch (e) { console.error(e); } finally { if (browser) await browser.close(); }
}

buscarPromo(false); 
setInterval(() => buscarPromo(false), 3600000);
