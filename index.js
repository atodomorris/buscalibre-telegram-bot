const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const qs = require("qs");

// ---------------------------
// Configuración
// ---------------------------
const CLOUD_NAME = "dvye0cje6";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ ERROR: Variables TELEGRAM no definidas.");
  process.exit(1);
}

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
// 3. Scraping y Lógica
// ---------------------------
async function buscarPromo(esPrueba = false) {
  console.log("🔎 Buscando promo en Buscalibre...", new Date().toLocaleString());

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", 
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // Importante para Railway (memoria)
      "--single-process" // Ahorra recursos
    ]
  });

  try {
    const page = await browser.newPage();
    // Bloqueamos carga de recursos pesados innecesarios (imágenes, fuentes) para ir más rápido
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
    
    // Vamos a la home
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Extraemos los datos (Script ligero)
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

    // --- LÓGICA INTELIGENTE (SILENT START) ---
    const archivoPromo = "ultimaPromo.json";
    let ultimaPromo = null;

    if (fs.existsSync(archivoPromo)) {
      try {
        ultimaPromo = JSON.parse(fs.readFileSync(archivoPromo, "utf-8"));
      } catch (e) {
        console.log("⚠️ Error leyendo JSON, se reiniciará.");
      }
    }

    // 1. MODO PRUEBA MANUAL (Forzado)
    if (esPrueba) {
      console.log("🧪 Modo Prueba: Enviando mensaje forzado.");
      await enviarTelegram(promoActual, "FULL");
    } 
    // 2. PRIMERA EJECUCIÓN O REINICIO (Sin memoria previa)
    else if (!ultimaPromo) {
      console.log("🆕 Inicio del sistema (o reinicio de Railway).");
      console.log("💾 Guardando estado actual sin enviar alerta (SILENT START).");
      // Guardamos la promo actual para tener una base de comparación, pero NO enviamos mensaje.
      fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
    }
    // 3. MODO MONITOR (Comparación normal)
    else {
      // A. Cambio de IMAGEN
      if (promoActual.idImagen !== ultimaPromo.idImagen) {
        console.log("🎨 Cambio de Banner -> Enviando FULL");
        await enviarTelegram(promoActual, "FULL");
        fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
      } 
      // B. Cambio de TEXTO
      else if (promoActual.textoCintillo !== ultimaPromo.textoCintillo) {
        if (promoActual.textoCintillo && promoActual.textoCintillo.length > 2) {
          console.log("⚡ Cambio de Cintillo -> Enviando TEXTO");
          await enviarTelegram(promoActual, "TEXT_ONLY");
          fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
        }
      } 
      else {
        console.log("💤 Sin cambios.");
      }
    }

  } catch (error) {
    console.error("Error general:", error);
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------------------
// Ejecución
// ---------------------------

// IMPORTANTE:
// He cambiado esto a 'false'. 
// Al arrancar en Railway, ejecutará el modo "Silent Start" (Guardar sin avisar).
// Solo te avisará cuando la promo cambie REALMENTE en el futuro.
buscarPromo(false); 

// Intervalo cada 1 hora
setInterval(() => buscarPromo(false), 3600000);
