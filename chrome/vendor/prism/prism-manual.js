// Must load before prism-core. Prism reads window.Prism.manual at init time;
// setting it true stops Prism from auto-highlighting / installing observers,
// since this extension highlights on demand via the highlight module.
window.Prism = window.Prism || {};
window.Prism.manual = true;
