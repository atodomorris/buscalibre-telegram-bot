const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const qs = require("qs");

// ---------------------------
// Función para limpiar caracteres raros
// ---------------------------
function limpiarTexto(texto) {
  if (!texto) return texto;

  return texto
    .replace(/Â¡/g, "¡")
    .replace(/Â¿/g, "¿")
    .replace(/Ã¡/g, "á")
    .replace(/Ã©/g, "é")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ãº/g, "ú")
    .replace(/Ã±/g, "ñ")
    .replace(/Ã/g, "Á")
    .replace(/&iexcl;/g, "¡");
}

// ---------------------------
// Variables de entorno Telegram
// ---------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ ERROR: Variables TELEGRAM no definidas.");
  process.exit(1);
}

// ---------------------------
// Variables Cloudinary
// ---------------------------
const CLOUD_NAME = "dvye0cje6";
const COLOR_FONDO = "fe8d10"; // naranja

// ---------------------------
// Cloudinary: canvas fijo 1000x327 centrado
// ---------------------------
function cloudinaryFetch(urlOriginal) {
  if (!urlOriginal) return urlOriginal;

  return (
    `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/` +
    `c_fit,w_1000,h_327,g_center,` +
    `b_rgb:${COLOR_FONDO},` +
    `f_jpg,q_auto/` +
    encodeURIComponent(urlOriginal)
  );
}

// ---------------------------
// Enviar TEXTO
// ---------------------------
async function enviarTextoTelegram(promo) {
  const mensaje =
    `🚨 *NUEVA PROMO DETECTADA!*\n\n` +
    `*${promo.texto.toUpperCase()}*`;

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    qs.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mensaje,
      parse_mode: "Markdown"
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
}

// ---------------------------
// Enviar IMAGEN + BOTÓN
// ---------------------------
async function enviarImagenTelegram(promo) {
  const urlTransformada = cloudinaryFetch(promo.imagen);

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`,
    qs.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      photo: urlTransformada,
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: "🚀 Ver Ofertas", url: promo.link }
        ]]
      })
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
}

// ---------------------------
// Flujo combinado
// ---------------------------
async function enviarPromoTelegram(promo) {
  await enviarTextoTelegram(promo);
  await enviarImagenTelegram(promo);
  console.log("✅ Promo enviada a Telegram");
}

// ---------------------------
// Función principal
// ---------------------------
async function buscarPromo(enviarMensajePrueba = false) {
  console.log("🔎 Buscando promo -", new Date().toLocaleString());

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  const promo = await page.evaluate(() => {
    const img = document.querySelector("section#portadaHome img[alt]");
    const link = img?.closest("a");

    return {
      texto: img?.alt || "SIN TEXTO",
      link: link ? "https://www.buscalibre.cl" + link.getAttribute("href") : "SIN LINK",
      imagen: img?.src || "SIN IMAGEN"
    };
  });

  promo.texto = limpiarTexto(promo.texto);

  const archivoPromo = "ultimaPromo.json";
  let ultimaPromo = null;

  if (fs.existsSync(archivoPromo)) {
    ultimaPromo = JSON.parse(fs.readFileSync(archivoPromo, "utf-8"));
  }

  if (enviarMensajePrueba) {
    console.log("📤 Enviando mensaje de prueba...");
    await enviarPromoTelegram(promo);
  }

  if (!ultimaPromo || JSON.stringify(ultimaPromo) !== JSON.stringify(promo)) {
    if (!enviarMensajePrueba) {
      await enviarPromoTelegram(promo);
    }
    fs.writeFileSync(archivoPromo, JSON.stringify(promo, null, 2), "utf-8");
  } else {
    console.log("ℹ️ Promo sin cambios.");
  }

  await browser.close();
}

// ---------------------------
// Primera ejecución (test)
// ---------------------------
buscarPromo(true);

// ---------------------------
// Revisión cada 1 hora
// ---------------------------
setInterval(buscarPromo, 3600000);
