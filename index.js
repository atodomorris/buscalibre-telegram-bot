const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const qs = require("qs");

// ---------------------------
// Configuración
// ---------------------------
const CLOUD_NAME = "dvye0cje6"; // Tu cloud name
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ ERROR: Variables TELEGRAM no definidas.");
  process.exit(1);
}

// ---------------------------
// 1. Fusión de Imágenes en Cloudinary (CORREGIDO TAMAÑO)
// ---------------------------
function crearImagenFusionada(urlBase, urlDetalle) {
  if (!urlBase) return null;
  if (!urlDetalle) return urlBase; 

  const urlDetalleB64 = Buffer.from(urlDetalle).toString('base64')
    .replace(/\+/g, '-') 
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // AJUSTE: w_1.0,fl_relative obliga a la capa superior a tener el mismo ancho que la base
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/` +
         `l_fetch:${urlDetalleB64}/fl_layer_apply,g_center,fl_relative,w_1.0/` +
         `q_auto,f_jpg/` + 
         urlBase;
}

// ---------------------------
// 2. Enviar a Telegram (CORREGIDO BOTÓN Y TEXTO)
// ---------------------------
async function enviarTelegram(promo, tipoMensaje) {
  
  // LÓGICA DE TÍTULO:
  // Si hay cintillo, usa ese texto. Si no, usa el fallback con el signo "!" asegurado.
  let textoPrincipal = promo.textoCintillo && promo.textoCintillo.length > 5
    ? promo.textoCintillo.toUpperCase()
    : "🚨 NUEVA PROMO DETECTADA!"; // Fallback con signo !

  // Aseguramos que el texto no tenga espacios extra
  textoPrincipal = textoPrincipal.trim();

  // Construimos el mensaje (Todo en negritas)
  // Nota: Eliminamos el link de texto "Ver Ofertas" de aquí porque irá en el botón
  let mensaje = `<b>${textoPrincipal}</b>`;

  // Añadimos la imagen invisible al final si es modo FULL
  if (tipoMensaje === "FULL" && promo.imagenFusionada) {
    mensaje += `<a href="${promo.imagenFusionada}">&#8205;</a>`;
    console.log("📤 Preparando envío: Imagen + Texto + Botón...");
  } else {
    console.log("📤 Preparando envío: Solo Texto + Botón...");
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      qs.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: "HTML",
        disable_web_page_preview: false, // Necesario para que se vea la imagen
        // AJUSTE: Botón nativo de Telegram
        reply_markup: JSON.stringify({
          inline_keyboard: [[
            { text: "🚀 Ver Ofertas", url: promo.link }
          ]]
        })
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    console.log("✅ Mensaje enviado con éxito.");
  } catch (error) {
    console.error("❌ Error enviando a Telegram:", error.message);
  }
}

// ---------------------------
// 3. Scraping
// ---------------------------
async function buscarPromo(enviarMensajePrueba = false) {
  console.log("🔎 Buscando cambios en Buscalibre -", new Date().toLocaleString());

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
    
    // Vamos a la home
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("body", { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    const datosScraped = await page.evaluate(() => {
      // --- A. Extracción del Cintillo (Mejorada) ---
      // Buscamos directamente el contenedor .avisoTop
      const avisoTop = document.querySelector(".avisoTop");
      let textoCintillo = "";
      let linkCintillo = null;

      if (avisoTop) {
        // Obtenemos todo el texto visible del bloque
        let rawText = avisoTop.innerText || "";
        // Limpiamos "Ver más" y espacios
        textoCintillo = rawText.replace(/Ver más/gi, "").trim();
        
        // Buscamos el link ahí mismo
        const enlace = avisoTop.querySelector("a");
        if (enlace) linkCintillo = enlace.href;
      }

      // --- B. Extracción del Banner ---
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
        textoCintillo: textoCintillo, 
        link: linkCintillo || linkBanner || "https://www.buscalibre.cl"
      };
    });

    // Debug: Ver qué texto capturó
    console.log("Texto detectado en cintillo:", datosScraped.textoCintillo);

    // Generar URL fusionada
    const imagenFusionada = crearImagenFusionada(datosScraped.jpgUrl, datosScraped.pngUrl);

    const promoActual = {
      idImagen: datosScraped.pngUrl, 
      textoCintillo: datosScraped.textoCintillo,
      link: datosScraped.link,
      imagenFusionada: imagenFusionada
    };

    // --- COMPARACIÓN ---
    const archivoPromo = "ultimaPromo.json";
    let ultimaPromo = {};

    if (fs.existsSync(archivoPromo)) {
      ultimaPromo = JSON.parse(fs.readFileSync(archivoPromo, "utf-8"));
    }

    if (enviarMensajePrueba) {
      // PRUEBA: Forzamos envío FULL
      await enviarTelegram(promoActual, "FULL"); 
    } 
    else {
      // 1. Cambio visual grande -> FULL
      if (promoActual.idImagen !== ultimaPromo.idImagen) {
        console.log("🎨 ¡Cambio de Banner detectado!");
        await enviarTelegram(promoActual, "FULL");
        fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
      } 
      // 2. Mismo banner, nuevo texto (flash) -> TEXT_ONLY
      else if (promoActual.textoCintillo !== ultimaPromo.textoCintillo && promoActual.textoCintillo !== "") {
        console.log("⚡ ¡Cambio de Cintillo detectado!");
        await enviarTelegram(promoActual, "TEXT_ONLY");
        fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
      } 
      else {
        console.log("ℹ️ Sin cambios.");
      }
    }

  } catch (error) {
    console.error("Error en el scraping:", error);
  } finally {
    await browser.close();
  }
}

// ---------------------------
// Ejecución
// ---------------------------
buscarPromo(true); 
setInterval(() => buscarPromo(false), 3600000);
