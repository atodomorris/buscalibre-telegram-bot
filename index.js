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
// 1. Fusión de Imágenes en Cloudinary
// ---------------------------
function crearImagenFusionada(urlBase, urlDetalle) {
  if (!urlBase) return null;
  if (!urlDetalle) return urlBase; // Si falla el PNG, manda al menos el fondo

  // Cloudinary necesita la URL de la capa superior en Base64 para usarla como overlay
  const urlDetalleB64 = Buffer.from(urlDetalle).toString('base64')
    .replace(/\+/g, '-') // Ajuste para URL Safe de Cloudinary
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Estructura: BaseURL + Transformación (Overlay centrada) + NombreArchivo
  // l_fetch: pone una imagen remota encima
  // fl_layer_apply: aplica la capa
  // g_center: centra la capa respecto al fondo
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/` +
         `l_fetch:${urlDetalleB64}/fl_layer_apply,g_center/` +
         `q_auto,f_jpg/` + // Calidad auto y formato final JPG
         urlBase;
}

// ---------------------------
// 2. Enviar a Telegram
// ---------------------------
async function enviarTelegram(promo, tipoMensaje) {
  let mensaje = "";
  
  // Título: Usamos el CINTILLO como texto principal ahora
  const titulo = promo.textoCintillo 
    ? `🚨 <b>${promo.textoCintillo.toUpperCase()}</b>` 
    : `🚨 <b>NUEVA PROMO DETECTADA</b>`;

  // Construimos el mensaje base
  mensaje += `${titulo}\n\n`;
  mensaje += `👉 <a href="${promo.link}">Ver Ofertas</a>`;

  // Lógica: ¿Enviamos foto o solo texto?
  if (tipoMensaje === "FULL" && promo.imagenFusionada) {
    // Truco: Ponemos la imagen en un link invisible al final para que Telegram la renderice
    mensaje += `<a href="${promo.imagenFusionada}">&#8205;</a>`;
    console.log("📤 Enviando Alerta COMPLETA (Imagen + Texto)...");
  } else {
    console.log("📤 Enviando Alerta FLASH (Solo Texto)...");
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      qs.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: "HTML",
        disable_web_page_preview: false // Importante: false para que se vea la imagen
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
    
    await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("body", { timeout: 20000 });
    
    // Espera extra para asegurar carga de estilos
    await new Promise(resolve => setTimeout(resolve, 3000));

    const datosScraped = await page.evaluate(() => {
      // A. Buscar CAPA DETALLE (PNG)
      const imgFrontal = document.querySelector("section#portadaHome img[alt]");
      
      // B. Buscar CAPA BASE (JPG - Background)
      // Buscamos el contenedor padre que tenga 'background-image'
      let bgUrl = null;
      if (imgFrontal) {
        const contenedor = imgFrontal.closest("div[style*='background-image']");
        if (contenedor) {
          const style = contenedor.getAttribute('style');
          // Regex para extraer la url dentro de url('...')
          const match = style.match(/url\(\s*['"]?(.*?)['"]?\s*\)/);
          if (match) bgUrl = match[1];
        }
      }

      // C. Buscar CINTILLO (Texto superior)
      const cintilloEl = document.querySelector(".avisoTop p");
      let textoCintillo = cintilloEl ? cintilloEl.innerText.trim() : "";
      
      // Limpieza básica del texto cintillo
      if(textoCintillo.includes("Ver más")) {
        textoCintillo = textoCintillo.replace("Ver más", "").trim();
      }

      const link = imgFrontal?.closest("a");

      return {
        pngUrl: imgFrontal?.src || "",
        jpgUrl: bgUrl || "", // La URL del fondo
        textoCintillo: textoCintillo,
        link: link ? link.href : "https://www.buscalibre.cl"
      };
    });

    // Generar la URL fusionada
    const imagenFusionada = crearImagenFusionada(datosScraped.jpgUrl, datosScraped.pngUrl);

    // Objeto final para comparar
    const promoActual = {
      idImagen: datosScraped.pngUrl, // Usamos la URL del PNG como ID único de la imagen visual
      texto: datosScraped.textoCintillo,
      link: datosScraped.link,
      imagenFusionada: imagenFusionada
    };

    // --- LÓGICA DE COMPARACIÓN ---
    const archivoPromo = "ultimaPromo.json";
    let ultimaPromo = {};

    if (fs.existsSync(archivoPromo)) {
      ultimaPromo = JSON.parse(fs.readFileSync(archivoPromo, "utf-8"));
    }

    // Modo PRUEBA
    if (enviarMensajePrueba) {
      await enviarTelegram(promoActual, "FULL"); // En prueba forzamos full
    } 
    else {
      // CASO 1: Cambió la IMAGEN (Campaña nueva grande) -> Enviar FULL
      if (promoActual.idImagen !== ultimaPromo.idImagen) {
        console.log("aaa ¡Cambio de Banner detectado!");
        await enviarTelegram(promoActual, "FULL");
        fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
      } 
      // CASO 2: La imagen es igual, pero cambió el TEXTO (Promo Relámpago) -> Enviar TEXTO
      else if (promoActual.texto !== ultimaPromo.texto && promoActual.texto !== "") {
        console.log("⚡ ¡Cambio de Cintillo detectado (Flash)!");
        await enviarTelegram(promoActual, "TEXT_ONLY");
        fs.writeFileSync(archivoPromo, JSON.stringify(promoActual, null, 2), "utf-8");
      } 
      else {
        console.log("ℹ️ Sin cambios relevantes.");
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
// Si pasas 'true' hace un envío de prueba inmediato
buscarPromo(true); 

// Intervalo cada 1 hora
setInterval(() => buscarPromo(false), 3600000);
