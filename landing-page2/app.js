function showBootFallback(message) {
  if (typeof window !== "undefined" && typeof window.__showLandingBootFallback === "function") {
    window.__showLandingBootFallback(message);
  }
}

if (typeof window !== "undefined" && window.location && window.location.protocol === "file:") {
  showBootFallback("Voce abriu a landing por arquivo local (file://). Use Live Server ou localhost para permitir leitura do temas.json.");
}

if (typeof Vue === "undefined") {
  showBootFallback("Vue nao carregou. Verifique internet/CDN e recarregue a pagina.");
  throw new Error("Vue is not defined");
}

const { createApp } = Vue;

createApp({
  data() {
    return {
      loading: true,
      error: "",
      themes: [],
      siteConfigs: [],
      theme: null,
      siteEntry: null,
      offer: null,
      showCatalog: false,
      selectedId: null,
      temasPathUsed: "",
      sitePathUsed: "",
      warning: "",
      pathCandidates: [
        "temas.json",
        "./temas.json",
        "../temas.json"
      ],
      sitePathCandidates: [
        "site.json",
        "./site.json",
        "../site.json"
      ],
    };
  },

  computed: {
    cssVars() {
      const primary = this.siteEntry?.cor || this.theme?.cor || "#1E1B4B";
      const onPrimary = this.siteEntry?.cor_fonte || this.theme?.cor_fonte || "#F8FAFC";
      const rgb = this.hexToRgb(primary);
      return {
        "--theme-primary": primary,
        "--theme-on-primary": onPrimary,
        "--theme-rgb": rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "30, 27, 75",
      };
    },

    chapterCards() {
      if (!this.theme?.estrutura?.capitulos) return [];
      return this.theme.estrutura.capitulos.map((cap) => {
        const title = Array.isArray(cap) ? cap[0] : "Capitulo";
        const prompt = Array.isArray(cap) ? cap[3] : "";
        const html = Array.isArray(cap) ? cap[4] : "";
        const summarySource = html ? this.stripHtml(html) : prompt;
        return {
          title: this.cleanText(title),
          summary: this.excerpt(this.cleanText(summarySource), 180),
          hasHtml: Boolean(html && String(html).trim()),
        };
      });
    },

    chapterTitles() {
      return this.chapterCards.map((c) => c.title);
    },

    chapterCardsPreview() {
      return this.chapterCards.slice(0, 4);
    },

    chapterSlides() {
      const cards = this.chapterCards || [];
      const chunkSize = 4;
      const slides = [];
      for (let i = 0; i < cards.length; i += chunkSize) {
        slides.push(cards.slice(i, i + chunkSize));
      }
      return slides;
    },

    benefitsPreview() {
      return Array.isArray(this.offer?.benefits) ? this.offer.benefits.slice(0, 3) : [];
    },

    testimonialsPreview() {
      return Array.isArray(this.offer?.testimonials) ? this.offer.testimonials.slice(0, 3) : [];
    },

    faqPreview() {
      return Array.isArray(this.offer?.faq) ? this.offer.faq.slice(0, 4) : [];
    },

    coverPngUrl() {
      const arq = this.siteEntry?.arquivos;
      if (!arq) return "";

      // Prioriza apenas o NOME do arquivo e busca na pasta local ./pdf
      const fileOnly = arq.capaPngPt || arq.capaPng || "";
      if (fileOnly) {
        return this.toLandingRelativeAssetUrl(`pdf/${fileOnly}`);
      }

      const folder = arq.pastaRelativa || (arq.pastaTema ? `output/${arq.pastaTema}` : "");
      const file = arq.capaPng || arq.capaPngPt || "";
      if (!folder || !file) return "";

      return this.toLandingRelativeAssetUrl(`${folder}/${file}`);
    },

    previewUrls() {
      const previews = this.offer?.previews || [];
      if (!Array.isArray(previews) || previews.length === 0) return [];

      return previews
        .map((item) => {
          if (!item) return "";
          if (typeof item === "string") {
            if (/^https?:\/\//i.test(item)) return item;
            // Se vier só o nome, assume ./previas/<arquivo>
            if (!item.includes("/")) return this.toLandingRelativeAssetUrl(`previas/${item}`);
            // Compatibilidade com caminhos antigos (pdf/... ou output/...)
            return this.toLandingRelativeAssetUrl(item);
          }
          if (typeof item === "object" && item.src) {
            const src = item.src;
            if (/^https?:\/\//i.test(src)) return src;
            if (!src.includes("/")) return this.toLandingRelativeAssetUrl(`previas/${src}`);
            return this.toLandingRelativeAssetUrl(src);
          }
          return "";
        })
        .filter(Boolean);
    },

    catalogItems() {
      if (!Array.isArray(this.themes)) return [];
      return this.themes.map((theme) => {
        const siteEntry = Array.isArray(this.siteConfigs)
          ? this.siteConfigs.find((s) => Number(s?.id) === Number(theme.id))
          : null;
        const siteConfig =
          siteEntry?.site ||
          siteEntry?.estrutura?.site ||
          siteEntry?.landing ||
          {};
        const arq = siteEntry?.arquivos || {};
        const coverName = arq.capaPngPt || arq.capaPng || "";
        const coverUrl = coverName
          ? this.toLandingRelativeAssetUrl(`pdf/${coverName}`)
          : "";
        const chapterCount = Array.isArray(theme?.estrutura?.capitulos)
          ? theme.estrutura.capitulos.length
          : 0;
        return {
          id: Number(theme.id),
          nome: theme.nome || `Tema ${theme.id}`,
          principal: theme.principal || "",
          subtitulo: theme.subtitulo || "",
          icone: theme.icone || "bi-book",
          cor: siteEntry?.cor || theme.cor || "#1E1B4B",
          corFonte: siteEntry?.cor_fonte || theme.cor_fonte || "#F8FAFC",
          preco: siteConfig?.oferta?.preco || "",
          chapterCount,
          coverUrl,
        };
      });
    },
  },

  methods: {
    async init() {
      this.loading = true;
      this.error = "";
      this.warning = "";
      this.theme = null;
      this.siteEntry = null;
      this.offer = null;
      this.showCatalog = false;

      try {
        if (window.location.protocol === "file:") {
          throw new Error(
            "Esta pagina foi aberta por file:// e o navegador bloqueia fetch do temas.json (CORS). Abra por localhost (Live Server) e use ?id=16."
          );
        }

        const [themes, siteConfigs] = await Promise.all([
          this.loadThemes(),
          this.loadSiteConfigs(),
        ]);
        this.themes = themes;
        this.siteConfigs = Array.isArray(siteConfigs) ? siteConfigs : [];

        const requestedId = this.parseThemeId();
        this.selectedId = requestedId;

        if (requestedId == null) {
          this.showCatalog = true;
          document.title = "Catalogo de E-books | Landing";
          return;
        }

        const theme =
          themes.find((t) => Number(t.id) === Number(requestedId)) || themes[0];

        if (!theme) {
          throw new Error("Nenhum tema encontrado no temas.json.");
        }

        const siteEntry = this.siteConfigs.find(
          (s) => Number(s?.id) === Number(theme.id)
        );
        const siteConfig =
          siteEntry?.site ||
          siteEntry?.estrutura?.site ||
          siteEntry?.landing ||
          null;

        this.siteEntry = siteEntry || null;
        this.theme = theme;
        this.offer = this.buildOffer(theme, siteConfig);
        this.applyPageMeta();

        if (!siteConfig) {
          this.warning =
            this.warning ||
            `ID ${theme.id} sem configuracao em site.json. A landing esta usando textos padrao/fallback do app.js.`;
        }

        if (
          requestedId != null &&
          !themes.some((t) => Number(t.id) === Number(requestedId))
        ) {
          this.warning = `ID ${requestedId} nao encontrado. Exibindo o primeiro tema disponivel (ID ${theme.id}).`;
        }
      } catch (err) {
        this.error = err?.message || "Falha ao carregar a landing.";
      } finally {
        this.loading = false;
      }
    },

    goToTheme(id) {
      const url = new URL(window.location.href);
      url.searchParams.set("id", String(id));
      window.location.href = url.toString();
    },

    parseThemeId() {
      const url = new URL(window.location.href);
      const qId = url.searchParams.get("id");
      if (qId && !Number.isNaN(Number(qId))) return Number(qId);

      const matchHref = window.location.href.match(/(?:\?|&|\/|#)id[=/](\d+)/i);
      if (matchHref) return Number(matchHref[1]);

      const hashMatch = window.location.hash.match(/id=(\d+)/i);
      if (hashMatch) return Number(hashMatch[1]);

      return null;
    },

    async loadThemes() {
      const errors = [];

      for (const path of this.pathCandidates) {
        try {
          
          const res = await fetch(path, { cache: "no-store" });

          if (!res.ok) {
            errors.push(`${path} -> HTTP ${res.status}`);
            continue;
          }

          const text = await res.text();
          const clean = text.replace(/^\uFEFF/, "");
          const json = JSON.parse(clean);

          if (!Array.isArray(json)) {
            errors.push(`${path} -> JSON nao e array`);
            continue;
          }

          this.temasPathUsed = path;

          return json;
        } catch (e) {
          errors.push(`${path} -> ${e.message}`);
        }
      }

      throw new Error(
        `Nao foi possivel carregar temas.json. Caminhos testados: ${errors.join(
          " | "
        )}`
      );
    },

    async loadSiteConfigs() {
      const errors = [];

      for (const path of this.sitePathCandidates) {
        try {
          const res = await fetch(path, { cache: "no-store" });

          if (!res.ok) {
            errors.push(`${path} -> HTTP ${res.status}`);
            continue;
          }

          const text = await res.text();
          const clean = text.replace(/^\uFEFF/, "");
          const json = JSON.parse(clean);

          if (!Array.isArray(json)) {
            errors.push(`${path} -> JSON nao e array`);
            continue;
          }

          this.sitePathUsed = path;
          return json;
        } catch (e) {
          errors.push(`${path} -> ${e.message}`);
        }
      }

      this.warning =
        this.warning ||
        `site.json nao carregado. A landing vai usar textos padrao do app.js. Caminhos testados: ${errors.join(
          " | "
        )}`;
      return [];
    },

    buildOffer(theme, externalSiteConfig = null) {
      const chapters = Array.isArray(theme?.estrutura?.capitulos)
        ? theme.estrutura.capitulos
        : [];

      const chapterCount = chapters.length || 0;
      const siteConfig = externalSiteConfig || theme?.estrutura?.site || {};
      const themeLanding = this.deepMerge(theme?.landing || {}, this.mapSiteToLanding(siteConfig));

      const defaults = {
        brandKicker: theme.principal || "Diagnostico",
        brandName: theme.nome || "Landing Dinamica por Tema",
        checkoutUrl: "https://kiwify.com.br/",
        headline: theme.nome || "Produto digital",
        subheadline: theme.subtitulo || "",
        price: "",
        anchoredPrice: "",
        paymentNote: "",
        guarantee: "",
        ctaPrimary: "Comprar agora",
        ctaSecondary: "Ver como funciona",
        quickProof: [],
        targetIntro: "",
        targetAudience: [],
        pains: [],
        desires: [],
        method: {
          name: "",
          steps: [],
        },
        howItWorks: [],
        benefits: [],
        differentials: [],
        scientificBase: [],
        testimonials: [],
        socialRating: null,
        offerDescription: "",
        offerItems: [
          { label: "Produto principal", value: "Diagnostico + Relatorio PDF" },
          { label: "Capitulos", value: String(chapterCount || 0) },
          { label: "Formato", value: "PDF digital" },
          { label: "Entrega", value: "Acesso imediato" },
        ],
        bonuses: [],
        faq: [],
        benefitStripTitle: "",
        benefitStripItems: [],
        trustBadges: [],
        previews: [],
        legalPages: {},
        contact: {},
        finalCtaTitle: theme.nome || "Produto digital",
        finalCtaText: theme.subtitulo || "",
      };

      return this.deepMerge(defaults, themeLanding);
    },

    deepMerge(base, overrides) {
      if (!overrides || typeof overrides !== "object") return base;
      const out = Array.isArray(base) ? [...base] : { ...base };

      Object.keys(overrides).forEach((key) => {
        const b = out[key];
        const o = overrides[key];
        if (
          b &&
          o &&
          typeof b === "object" &&
          typeof o === "object" &&
          !Array.isArray(b) &&
          !Array.isArray(o)
        ) {
          out[key] = this.deepMerge(b, o);
        } else {
          out[key] = o;
        }
      });

      return out;
    },

    mapSiteToLanding(site) {
      if (!site || typeof site !== "object") return {};

      const hero = site.hero || {};
      const branding = site.branding || {};
      const audience = site.publicoAlvo || {};
      const mechanism = site.mecanismo || {};
      const how = site.comoFunciona || {};
      const benefits = site.beneficios || {};
      const differentials = site.diferenciais || {};
      const social = site.provaSocial || {};
      const offer = site.oferta || {};
      const faq = site.faq || {};
      const finalCta = site.ctaFinal || {};

      return {
        brandKicker: branding.kicker,
        brandName: branding.nome,
        checkoutUrl: offer.checkoutUrl,
        headline: hero.headline,
        subheadline: hero.subheadline,
        price: offer.preco,
        anchoredPrice: offer.precoAncorado,
        paymentNote: offer.notaPagamento,
        ctaPrimary: hero.ctaPrincipal?.texto || offer.cta?.texto,
        ctaSecondary: hero.ctaSecundario?.texto,
        quickProof: hero.provasRapidas,
        targetIntro: audience.introducao,
        targetAudience: audience.itens,
        pains: site.dores?.itens,
        desires: site.desejos?.itens,
        method: {
          name: mechanism.nome,
          steps: mechanism.passos,
        },
        howItWorks: how.passos,
        benefits: benefits.itens,
        differentials: differentials.itens,
        scientificBase: site.baseCientifica?.itens,
        testimonials: social.depoimentos,
        socialRating: social.rating,
        offerDescription: offer.descricao,
        offerItems: offer.itens,
        bonuses: site.bonus?.itens,
        faq: faq.itens,
        benefitStripTitle: hero.benefitStrip?.titulo,
        benefitStripItems: hero.benefitStrip?.itens,
        trustBadges: hero.trustBadges,
        previews: site.previews,
        legalPages: site.paginasLegais,
        contact: site.contato,
        finalCtaTitle: finalCta.titulo,
        finalCtaText: finalCta.texto,
      };
    },

    applyPageMeta() {
      if (!this.theme || !this.offer) return;
      document.title = `${this.theme.nome} | ${this.offer.brandName}`;

      const meta = document.querySelector('meta[name="description"]');
      if (meta) {
        meta.setAttribute(
          "content",
          `${this.theme.nome}. ${this.offer.subheadline}`.slice(0, 160)
        );
      }
    },

    stripHtml(html) {
      const tmp = document.createElement("div");
      tmp.innerHTML = String(html || "");
      return tmp.textContent || tmp.innerText || "";
    },

    cleanText(text) {
      return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    },

    excerpt(text, max) {
      const t = this.cleanText(text);
      if (!t) return "Capitulo configurado para esse tema.";
      if (t.length <= max) return t;
      return `${t.slice(0, max).trimEnd()}...`;
    },

    toLandingRelativeAssetUrl(rootRelativePath) {
      const normalized = String(rootRelativePath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!normalized) return "";
      // Se o caminho ja e interno da landing-page (ex.: img/... ou pdf/...), usa relativo local.
      if (normalized.startsWith("img/") || normalized.startsWith("pdf/") || normalized.startsWith("previas/")) {
        return `./${normalized
          .split("/")
          .map((seg) => encodeURIComponent(seg))
          .join("/")}`;
      }
      // landing-page esta 1 nivel abaixo da raiz do projeto
      return `../${normalized
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/")}`;
    },

    hexToRgb(hex) {
      if (!hex) return null;
      const normalized = String(hex).replace("#", "").trim();
      if (![3, 6].includes(normalized.length)) return null;
      const full =
        normalized.length === 3
          ? normalized
              .split("")
              .map((c) => c + c)
              .join("")
          : normalized;
      const int = Number.parseInt(full, 16);
      if (Number.isNaN(int)) return null;
      return {
        r: (int >> 16) & 255,
        g: (int >> 8) & 255,
        b: int & 255,
      };
    },
  },

  mounted() {
    const boot = document.getElementById("boot-fallback");
    if (boot) boot.classList.remove("show");
    this.init();
  },
}).mount("#app");
