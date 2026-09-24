import {
  regionsGeoJSON,
  regionsKML,
  regionsSVG,
  regionsTopoJSON,
  setMarkdownFor,
  type ExportInput,
} from './formats';

/** Browser side of export: the file for each format, SVG to PNG through a canvas, and the download. */

export const EXPORT_FORMATS = [
  { id: 'pack', label: 'Region pack (.json)' },
  { id: 'geojson', label: 'GeoJSON' },
  { id: 'topojson', label: 'TopoJSON' },
  { id: 'kml', label: 'KML (Google My Maps)' },
  { id: 'svg', label: 'SVG' },
  { id: 'png', label: 'PNG' },
  { id: 'markdown', label: 'Dossiers (.md)' },
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number]['id'];

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'split'
  );
}

export async function exportFile(input: ExportInput, format: ExportFormat): Promise<File | null> {
  const base = `meridian-${slug(input.title)}`;
  const json = (value: unknown, ext: string, type: string) =>
    new File([JSON.stringify(value)], `${base}.${ext}`, { type });
  switch (format) {
    case 'pack':
      return json(input.pack, 'json', 'application/json');
    case 'geojson':
      return json(regionsGeoJSON(input), 'geojson', 'application/geo+json');
    case 'topojson':
      return json(regionsTopoJSON(input), 'topojson', 'application/json');
    case 'kml':
      return new File([regionsKML(input)], `${base}.kml`, { type: 'application/vnd.google-earth.kml+xml' });
    case 'svg':
      return new File([regionsSVG(input)], `${base}.svg`, { type: 'image/svg+xml' });
    case 'png':
      return new File([await svgToPng(regionsSVG(input))], `${base}.png`, { type: 'image/png' });
    case 'markdown': {
      const text = setMarkdownFor(input);
      return text === null ? null : new File([text], `${base}.md`, { type: 'text/markdown' });
    }
  }
}

/** Rasterise an SVG at `scale` times its size through an <img> and a canvas. */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
