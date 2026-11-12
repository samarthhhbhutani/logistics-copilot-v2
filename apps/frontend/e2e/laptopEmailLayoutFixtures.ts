/** Synthetic sender layouts modelled on the measured laptop overflow. No real mail content. */
export type WidthStyleSource = 'htmlAttributes' | 'inlineStyles' | 'importantStylesheet';

const imageServerUrl = 'https://127.0.0.1:4184/synthetic/inlineImage/logo.png';
// The local image server answers kind=responsive* with a 160x80 PNG.
export const bannerImageUrl = `${imageServerUrl}?kind=responsiveBanner`;
export const smallLogoUrl = `${imageServerUrl}?kind=responsiveLogo`;
export const deniedImageUrl = 'https://127.0.0.1:4184/synthetic/denied/banner.png';
export const delayedImageUrl = (retryCase: string) =>
  `${imageServerUrl}?kind=responsiveDelayed&retryScenario=slowBody&retryCase=${retryCase}`;

export const finalLine = 'End of synthetic layout.';
export const cellTexts = [
  'Ocean freight Nhava Sheva to Rotterdam, two 40ft HC, cargo ready 18 November.',
  `BOOKINGREFERENCE${'X'.repeat(64)}`,
  'Banner column',
  'Valid until 30 November, subject to space and equipment.',
  'USD 1,850',
];

const widths = {
  htmlAttributes: {
    outerTable: 'width="550"',
    nestedTable: 'width="1456"',
    wideColumn: 'width="970"',
    narrowColumn: 'width="486"',
    paddedContainer: 'style="width:1000px;padding:0 40px"',
    banner: 'width="1100" height="550"',
    logo: 'width="80" height="40"',
  },
  inlineStyles: {
    outerTable: 'style="width:550px"',
    nestedTable: 'style="width:1456px;min-width:1456px;table-layout:fixed"',
    wideColumn: 'style="width:970px;min-width:970px"',
    narrowColumn: 'style="width:486px;min-width:486px"',
    paddedContainer: 'style="width:1000px;min-width:1000px;padding:0 40px"',
    banner: 'style="width:1100px;height:550px"',
    logo: 'style="width:80px;height:40px"',
  },
  importantStylesheet: {
    outerTable: 'class="outerTable"',
    nestedTable: 'class="nestedTable"',
    wideColumn: 'class="wideColumn"',
    narrowColumn: 'class="narrowColumn"',
    paddedContainer: 'class="paddedContainer"',
    banner: 'class="banner"',
    logo: 'class="logo"',
  },
} satisfies Record<WidthStyleSource, Record<string, string>>;

const importantStylesheet = `<style>
.outerTable { width: 550px !important; }
.nestedTable { width: 1456px !important; min-width: 1456px !important; table-layout: fixed !important; }
.wideColumn { width: 970px !important; min-width: 970px !important; }
.narrowColumn { width: 486px !important; min-width: 486px !important; }
.paddedContainer { width: 1000px !important; min-width: 1000px !important; padding: 0 40px !important; }
.banner { width: 1100px !important; height: 550px !important; }
.logo { width: 80px !important; height: 40px !important; }
</style>`;

export function fixedWidthLayoutHtml(
  source: WidthStyleSource,
  bannerUrl: string = bannerImageUrl,
): string {
  const width = widths[source];
  return [
    source === 'importantStylesheet' ? importantStylesheet : '',
    `<table ${width.outerTable} cellpadding="0" cellspacing="0"><tr><td>`,
    `<img src="${smallLogoUrl}" ${width.logo} alt="Small logo">`,
    `<table ${width.nestedTable} cellpadding="8" cellspacing="0">`,
    `<colgroup><col ${width.wideColumn}><col ${width.narrowColumn}></colgroup>`,
    `<tr><td ${width.wideColumn}>${cellTexts[0]}<br>${cellTexts[1]}</td>`,
    `<td ${width.narrowColumn}>${cellTexts[2]}<br><a href="https://carrier.example/offer"><img src="${bannerUrl}" ${width.banner} alt="Linked banner"></a></td></tr>`,
    `<tr><td ${width.wideColumn}>${cellTexts[3]}</td><td ${width.narrowColumn}>${cellTexts[4]}</td></tr>`,
    '</table></td></tr></table>',
    `<div ${width.paddedContainer}><p>Padded fixed container text that must wrap within the reader.</p></div>`,
    `<p>${finalLine}</p>`,
  ].join('');
}

/** Sender cascade cases the width normalization must respect; elements are found by title. */
export const senderCascadeHtml = [
  `<style>
.narrowTable { width: 420px; }
.shared { width: 1200px; }
@media (min-width: 900px) { .mediaTable { width: 800px; } }
@media (max-width: 899px) { .mediaTable { width: 500px; } }
</style>`,
  '<div title="maxWidthContainer" style="max-width:600px"><p>Container keeps its sender maximum.</p></div>',
  '<table title="stylesheetWidthTable" width="550" class="narrowTable"><tr><td>Stylesheet width beats the attribute.</td></tr></table>',
  '<table title="sharedClassTable" class="shared"><tr><td class="shared">Shared left</td><td class="shared">Shared right</td></tr></table>',
  '<table title="mediaWidthTable" class="mediaTable"><tr><td>Media query width.</td></tr></table>',
  `<p>${finalLine}</p>`,
].join('');
