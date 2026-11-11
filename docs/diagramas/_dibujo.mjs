// =============================================================================
// Primitivas para dibujar el MER: cajas de entidad, conectores y rotulos.
//
// POR QUE LOS CONECTORES SE CALCULAN Y NO SE ESCRIBEN A MANO.
// El diagrama anterior tenia las coordenadas de cada linea escritas a mano.
// Con 12 entidades ya habia rotulos encimados sobre lineas y conectores que
// corrian pegados uno al otro; con 17 tablas y 30 relaciones, mover una caja
// obligaba a rehacer media docena de recorridos. Aca solo se fija DONDE va
// cada entidad: el recorrido de cada relacion lo busca un A* sobre una grilla
// de 10 px que no puede atravesar cajas ni montarse sobre otra linea, y el
// rotulo se coloca donde no pise nada.
//
// Todo se emite con clases (ent, rel, card...): _generar.mjs las traduce a
// atributos de presentacion, igual que hacia con las fuentes escritas a mano.
// =============================================================================

const G = 10;                 // paso de la grilla
const CAB = 26;               // alto de la cabecera de una entidad
const LINEA_ATR = 16;         // interlineado de los atributos

// Ancho aproximado de un texto, para colocar rotulos sin que se pisen. Es
// deliberadamente generoso: si la tipografia real es mas angosta, sobra aire;
// si fuera al reves, el rotulo se encimaria y nadie lo notaria en el codigo.
export function anchoTexto(texto, clase) {
  const mono = ['card', 'card-amb', 'atr', 'pk', 'der', 'zona'].includes(clase);
  const tam = { card: 11, 'card-amb': 11, verb: 11.5, atr: 11, pk: 11, der: 11, zona: 10.5,
                nom: 14, leg: 12.5 }[clase] ?? 12;
  return texto.length * tam * (mono ? 0.62 : 0.56);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Direcciones: 0 derecha, 1 abajo, 2 izquierda, 3 arriba.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

class Monticulo {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(prio, valor) {
    const a = this.a; a.push([prio, valor]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const ult = a.pop();
    if (a.length) {
      a[0] = ult;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top[1];
  }
}

export class Lienzo {
  constructor(ancho, alto) {
    this.W = ancho;
    this.H = alto;
    this.NX = ancho / G + 1;
    this.NY = alto / G + 1;
    this.cajas = new Map();        // id -> {x, y, w, h}
    this.obstaculos = [];          // zonas que ni lineas ni rotulos pueden pisar
    this.fondo = [];               // SVG que va debajo de todo
    this.cuerpo = [];              // SVG de entidades
    this.trazos = [];              // SVG de conectores
    this.textos = [];              // SVG de rotulos
    this.segmentos = [];           // [x1,y1,x2,y2] en px, de todos los conectores
    this.rotulos = [];             // cajas ocupadas por rotulos ya colocados
    this.ocupH = new Uint8Array(this.NX * this.NY);
    this.ocupV = new Uint8Array(this.NX * this.NY);
    this.puertos = new Uint8Array(this.NX * this.NY);
    // Puntos del borde por donde solo se puede SALIR: los costados de las filas
    // de clave foranea. Si otra flecha llegara ahi, la columna se quedaria sin
    // salida (paso con SYNC_LOG llegando a DISPOSITIVO por la fila tienda_id).
    this.soloSalida = new Uint8Array(this.NX * this.NY);
    this.relaciones = [];
    this.avisos = [];
  }

  // ---------------------------------------------------------------------------
  // Entidades
  // ---------------------------------------------------------------------------

  /**
   * Dibuja una entidad. `atributos` es una lista de [texto, clase], con clase
   * 'pk', 'atr' o 'der'. El alto se calcula y se redondea a la grilla, para
   * que los conectores puedan llegar a cualquier punto del borde.
   */
  entidad(id, { x, y, ancho = 260, nombre = id, tipo = 'fuerte', atributos = [], nota }) {
    const filas = atributos.length + (nota ? 1 : 0);
    const alto = Math.ceil((CAB + filas * LINEA_ATR + 18 + (nota ? 6 : 0)) / G) * G;
    const cuerpo = alto - CAB;
    this.cajas.set(id, { x, y, w: ancho, h: alto, tipo });
    this.bloqueado = null;   // el mapa de obstaculos se rehace con la caja nueva

    const clases = {
      fuerte:     ['cab-ent', 'ent', 'nom'],
      debil:      ['cab-deb', 'ent-deb', 'nom'],
      asociativa: ['cab-deb', 'ent-aso', 'nom'],
      contexto:   ['cab-ctx', 'ent-ctx', 'nom-ctx'],
    }[tipo];

    const s = [];
    s.push(`<!-- ${nombre} -->`);
    s.push(`<rect class="${clases[1]}" x="${x}" y="${y + CAB}" width="${ancho}" height="${cuerpo}"/>`);
    s.push(`<rect class="${clases[0]}" x="${x}" y="${y}" width="${ancho}" height="${CAB}"/>`);
    if (tipo === 'debil') {
      s.push(`<rect class="ent-deb-int" x="${x + 4}" y="${y + CAB + 4}" width="${ancho - 8}" height="${cuerpo - 8}"/>`);
    }
    s.push(`<text class="${clases[2]}" x="${x + ancho / 2}" y="${y + 18}" text-anchor="middle">${esc(nombre)}</text>`);
    let ty = y + CAB + 19;
    for (const [texto, clase] of atributos) {
      s.push(`<text class="${clase}" x="${x + 14}" y="${ty}">${esc(texto)}</text>`);
      ty += LINEA_ATR;
    }
    if (nota) s.push(`<text class="der" x="${x + 14}" y="${ty + 6}">${esc(nota)}</text>`);
    this.cuerpo.push(s.join('\n  '));
    return this.cajas.get(id);
  }

  /**
   * Tabla del modelo relacional: una fila por columna, de 20 px, para que
   * el centro de cada fila caiga sobre la grilla y una clave foranea pueda
   * salir exactamente de la fila de su columna.
   *
   * filas: [{ marcas: ['PK','FK'], nombre, tipo, nulo }]
   * Devuelve la caja y el y (en px) del centro de cada fila, por nombre.
   */
  tabla(id, { x, y, ancho, filas }) {
    const CAB_T = 30, FILA = 20;
    const alto = CAB_T + filas.length * FILA + 10;
    this.cajas.set(id, { x, y, w: ancho, h: alto, tipo: 'tabla' });
    this.bloqueado = null;
    const s = [`<!-- tabla ${id} -->`];
    s.push(`<rect class="ent" x="${x}" y="${y + CAB_T}" width="${ancho}" height="${alto - CAB_T}"/>`);
    s.push(`<rect class="cab-ent" x="${x}" y="${y}" width="${ancho}" height="${CAB_T}"/>`);
    s.push(`<text class="nom" x="${x + ancho / 2}" y="${y + 20}" text-anchor="middle">${esc(id)}</text>`);
    const centros = {};
    filas.forEach((f, k) => {
      const cy = y + CAB_T + FILA / 2 + k * FILA;
      centros[f.nombre] = cy;
      if (k % 2 === 1) {
        s.push(`<rect fill="#F4F6F8" x="${x + 1}" y="${cy - 10}" width="${ancho - 2}" height="${FILA}"/>`);
      }
      const base = cy + 4;
      if (f.marcas.length) {
        s.push(`<text class="${f.marcas.includes('PK') ? 'card-amb' : 'card'}" x="${x + 10}" y="${base}">${f.marcas.join(' ')}</text>`);
      }
      s.push(`<text class="${f.marcas.includes('PK') ? 'pk' : 'atr'}" x="${x + 56}" y="${base}">${esc(f.nombre)}</text>`);
      s.push(`<text class="${f.tipo === 'calculada' ? 'der' : 'zona'}" x="${x + ancho - 10}" y="${base}" text-anchor="end">${esc(f.tipo + (f.nulo ? ' NULL' : ''))}</text>`);
    });
    this.cuerpo.push(s.join('\n  '));
    return { ...this.cajas.get(id), centros };
  }

  /** Reserva los dos costados de una fila como puntos de salida exclusivos. */
  reservarSalida(id, py) {
    const c = this.cajas.get(id);
    this.soloSalida[this.idx(c.x / G, py / G)] = 1;
    this.soloSalida[this.idx((c.x + c.w) / G, py / G)] = 1;
  }

  /** Zona que los conectores y los rotulos tienen que esquivar (titulo, leyenda...). */
  reservar(x, y, w, h) {
    this.obstaculos.push({ x, y, w, h });
    this.bloqueado = null;
  }

  // ---------------------------------------------------------------------------
  // Grilla
  // ---------------------------------------------------------------------------

  idx(i, j) { return j * this.NX + i; }

  /** Caja (entidad u obstaculo) que contiene el punto, borde incluido. */
  cajaEn(px, py) {
    for (const [id, c] of this.cajas) {
      if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) return id;
    }
    for (const o of this.obstaculos) {
      if (px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h) return '#obstaculo';
    }
    return null;
  }

  construirMapa() {
    if (this.bloqueado) return;
    this.bloqueado = new Uint8Array(this.NX * this.NY);
    this.cerca = new Uint8Array(this.NX * this.NY);
    for (let j = 0; j < this.NY; j++) {
      for (let i = 0; i < this.NX; i++) {
        if (this.cajaEn(i * G, j * G)) this.bloqueado[this.idx(i, j)] = 1;
      }
    }
    // "Cerca" = a un paso de una caja. Ahi no se dobla: asi cada conector sale
    // y llega al borde con un tramo recto de al menos 20 px, donde se ve la
    // flecha y no parece que la linea corra pegada a la entidad.
    for (let j = 1; j < this.NY - 1; j++) {
      for (let i = 1; i < this.NX - 1; i++) {
        const k = this.idx(i, j);
        if (this.bloqueado[k]) continue;
        if (this.bloqueado[k - 1] || this.bloqueado[k + 1] ||
            this.bloqueado[k - this.NX] || this.bloqueado[k + this.NX]) this.cerca[k] = 1;
      }
    }
  }

  /** Puntos del borde de una caja donde puede nacer o terminar un conector. */
  puertosDe(id) {
    const c = this.cajas.get(id);
    const res = [];
    const i0 = c.x / G, i1 = (c.x + c.w) / G, j0 = c.y / G, j1 = (c.y + c.h) / G;
    const libre = (i, j) => {
      // Dos conectores no pueden tocar el borde a menos de 20 px uno del otro.
      for (let d = -1; d <= 1; d++) {
        const ii = i + (j === j0 || j === j1 ? d : 0);
        const jj = j + (i === i0 || i === i1 ? d : 0);
        if (this.puertos[this.idx(ii, jj)]) return false;
      }
      return true;
    };
    for (let i = i0 + 2; i <= i1 - 2; i++) {
      if (libre(i, j0)) res.push([i, j0, 3]);
      if (libre(i, j1)) res.push([i, j1, 1]);
    }
    for (let j = j0 + 2; j <= j1 - 2; j++) {
      if (libre(i0, j)) res.push([i0, j, 2]);
      if (libre(i1, j)) res.push([i1, j, 0]);
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Conectores
  // ---------------------------------------------------------------------------

  /**
   * Une dos entidades. La flecha apunta al lado N de la relacion.
   *
   * op.lados restringe los lados por donde puede salir o llegar
   * ({ desde: 'abajo', hasta: 'izquierda' }); sin eso el A* elige solo.
   */
  relacion(desde, hasta, { card, verbo, clase = 'rel', identificadora = false, lados = {}, filaDesde } = {}) {
    this.relaciones.push({ desde, hasta, card, verbo, clase, identificadora, lados, filaDesde });
  }

  trazar() {
    this.construirMapa();
    // Cada conector trazado ocupa la grilla, asi que uno de los ultimos puede
    // quedar encerrado por los anteriores. Si pasa, se deshace todo, se pone
    // primero al que no encontro camino y se vuelve a trazar.
    const copia = {
      ocupH: this.ocupH.slice(), ocupV: this.ocupV.slice(), puertos: this.puertos.slice(),
      segmentos: this.segmentos.length, trazos: this.trazos.length,
    };
    let fallidas = [];
    for (let intento = 0; intento < 6; intento++) {
      fallidas = [];
      for (const r of this.relaciones) {
        r.ruta = null;
        const ruta = this.buscarRuta(r);
        if (!ruta) { fallidas.push(r); continue; }
        r.ruta = ruta;
        this.ocupar(ruta);
        this.dibujarRuta(r);
      }
      if (!fallidas.length) break;
      this.ocupH = copia.ocupH.slice(); this.ocupV = copia.ocupV.slice(); this.puertos = copia.puertos.slice();
      this.segmentos.length = copia.segmentos; this.trazos.length = copia.trazos;
      this.relaciones = [...fallidas, ...this.relaciones.filter((r) => !fallidas.includes(r))];
    }
    for (const r of fallidas) this.avisos.push(`sin recorrido posible: ${r.desde} -> ${r.hasta}`);
    for (const r of this.relaciones) if (r.ruta && (r.card || r.verbo)) this.rotular(r);
  }

  buscarRuta({ desde, hasta, lados, filaDesde }) {
    const LADO = { derecha: 0, abajo: 1, izquierda: 2, arriba: 3 };
    const filtra = (lista, lado) => lado == null ? lista
      : lista.filter((p) => [].concat(lado).map((l) => LADO[l]).includes(p[2]));
    let salidas = filtra(this.puertosDe(desde), lados.desde);
    // En el modelo relacional la linea sale de la fila de la columna FK, por
    // el costado: asi se lee que columna apunta a que tabla.
    if (filaDesde != null) {
      salidas = salidas.filter((p) => p[1] * G === filaDesde && (p[2] === 0 || p[2] === 2));
    }
    const llegadasLista = filtra(this.puertosDe(hasta), lados.hasta)
      // Tampoco a 10 px: dos puertos tienen que quedar a 20 px, asi que una
      // llegada pegada a la fila tambien le quitaria la salida.
      .filter(([i, j]) => ![[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]
        .some(([di, dj]) => this.soloSalida[this.idx(i + di, j + dj)]));
    const llegadas = new Map(llegadasLista.map((p) => [this.idx(p[0], p[1]), p]));
    if (!salidas.length || !llegadas.size) return null;

    const destino = this.cajas.get(hasta);
    const h = (i, j) => {
      const px = i * G, py = j * G;
      const dx = Math.max(destino.x - px, 0, px - destino.x - destino.w);
      const dy = Math.max(destino.y - py, 0, py - destino.y - destino.h);
      return (dx + dy) / G;
    };

    const N = this.NX * this.NY;
    const costo = new Float64Array(N * 4).fill(Infinity);
    const previo = new Int32Array(N * 4).fill(-1);
    const abierta = new Monticulo();

    for (const [i, j, dir] of salidas) {
      const k = this.idx(i, j) * 4 + dir;
      costo[k] = 0;
      abierta.push(h(i, j), k);
    }

    while (abierta.size) {
      const k = abierta.pop();
      const nodo = k >> 2, dir = k & 3;
      const i = nodo % this.NX, j = (nodo - i) / this.NX;
      const c = costo[k];

      // Llegada: un nodo del borde destino, alcanzado desde afuera.
      if (llegadas.has(nodo) && previo[k] !== -1) {
        const [, , ladoLlegada] = llegadas.get(nodo);
        if (dir === (ladoLlegada + 2) % 4) return this.reconstruir(k, previo);
      }

      const enSalida = previo[k] === -1;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (dir + 2) % 4) continue;               // no se vuelve atras
        if (enSalida && nd !== dir) continue;             // sale perpendicular al borde
        const giro = nd !== dir;
        if (giro && (this.cerca[nodo] || enSalida)) continue;
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= this.NX || nj >= this.NY) continue;
        const nn = this.idx(ni, nj);
        const esLlegada = llegadas.has(nn);
        if (this.bloqueado[nn] && !esLlegada) continue;
        if (esLlegada && this.cerca[nodo] === 0 && !this.bloqueado[nodo]) {
          // permitido: se llega desde un nodo libre
        }
        const horizontal = nd === 0 || nd === 2;
        // Montarse sobre otra linea esta prohibido: dos conectores superpuestos
        // se leen como uno solo.
        if (horizontal ? this.ocupH[nn] : this.ocupV[nn]) continue;
        if (horizontal ? this.ocupH[nodo] && !enSalida : this.ocupV[nodo] && !enSalida) continue;
        if (this.puertos[nn]) continue;

        let paso = 1;
        if (giro) {
          // Doblar sobre un cruce dejaria una esquina encima de otra linea.
          if (this.ocupH[nodo] || this.ocupV[nodo]) continue;
          paso += 6;
        }
        if (horizontal ? this.ocupV[nn] : this.ocupH[nn]) paso += 5;    // cruce
        // Lineas paralelas a 10 px se confunden: se cobra correr pegado.
        if (horizontal) {
          if ((nj > 0 && this.ocupH[nn - this.NX]) || (nj < this.NY - 1 && this.ocupH[nn + this.NX])) paso += 3;
        } else if ((ni > 0 && this.ocupV[nn - 1]) || (ni < this.NX - 1 && this.ocupV[nn + 1])) paso += 3;
        if (this.cerca[nn] && !esLlegada) paso += 0.6;

        const nk = nn * 4 + nd;
        if (c + paso < costo[nk]) {
          costo[nk] = c + paso;
          previo[nk] = k;
          abierta.push(c + paso + h(ni, nj), nk);
        }
      }
    }
    return null;
  }

  reconstruir(k, previo) {
    const nodos = [];
    for (let x = k; x !== -1; x = previo[x]) nodos.push(x >> 2);
    nodos.reverse();
    return nodos.map((n) => [(n % this.NX) * G, Math.floor(n / this.NX) * G]);
  }

  /** Marca la ruta como ocupada para que ninguna otra se monte encima. */
  ocupar(puntos) {
    for (let a = 0; a < puntos.length - 1; a++) {
      const [x1, y1] = puntos[a], [x2, y2] = puntos[a + 1];
      const k1 = this.idx(x1 / G, y1 / G), k2 = this.idx(x2 / G, y2 / G);
      if (y1 === y2) { this.ocupH[k1] = 1; this.ocupH[k2] = 1; }
      else { this.ocupV[k1] = 1; this.ocupV[k2] = 1; }
    }
    const [xa, ya] = puntos[0], [xb, yb] = puntos[puntos.length - 1];
    this.puertos[this.idx(xa / G, ya / G)] = 1;
    this.puertos[this.idx(xb / G, yb / G)] = 1;
  }

  /** Reduce la lista de nodos a sus esquinas. */
  static esquinas(puntos) {
    const res = [puntos[0]];
    for (let a = 1; a < puntos.length - 1; a++) {
      const [x0, y0] = res[res.length - 1], [x1, y1] = puntos[a], [x2, y2] = puntos[a + 1];
      const recto = (x0 === x1 && x1 === x2) || (y0 === y1 && y1 === y2);
      if (!recto) res.push(puntos[a]);
    }
    res.push(puntos[puntos.length - 1]);
    return res;
  }

  static comoPath(esq) {
    let d = `M${esq[0][0]},${esq[0][1]}`;
    for (let a = 1; a < esq.length; a++) {
      const [x0, y0] = esq[a - 1], [x1, y1] = esq[a];
      d += y0 === y1 ? ` H${x1}` : ` V${y1}`;
    }
    return d;
  }

  dibujarRuta(r) {
    const esq = Lienzo.esquinas(r.ruta);
    r.esquinas = esq;
    for (let a = 0; a < esq.length - 1; a++) this.segmentos.push([...esq[a], ...esq[a + 1]]);
    const d = Lienzo.comoPath(esq);
    const amb = r.clase === 'rel-amb';
    if (r.identificadora) {
      // Doble linea: un trazo grueso y uno blanco encima. Con dos paralelas
      // desplazadas, cada esquina tendria que calcularse aparte.
      this.trazos.push(`<path class="rel-amb" d="${d}" stroke-width="6"/>`);
      this.trazos.push(`<path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="2.4"/>`);
      // El marcador escala con el grosor del trazo: con grosor 0 la flecha
      // desaparece. Se oculta la linea con la opacidad, no con el grosor.
      this.trazos.push(`<path class="rel-amb" d="${d}" stroke-opacity="0" marker-end="url(#mb)"/>`);
    } else {
      this.trazos.push(`<path class="${r.clase}" d="${d}" marker-end="url(#${amb ? 'mb' : 'ma'})"/>`);
    }
  }

  // ---------------------------------------------------------------------------
  // Rotulos
  // ---------------------------------------------------------------------------

  choca(b) {
    const M = 3;
    const se = (a, c) => a.x < c.x + c.w + M && a.x + a.w + M > c.x && a.y < c.y + c.h + M && a.y + a.h + M > c.y;
    if (b.x < 4 || b.y < 4 || b.x + b.w > this.W - 4 || b.y + b.h > this.H - 4) return true;
    for (const c of this.cajas.values()) if (se(b, c)) return true;
    for (const c of this.obstaculos) if (se(b, c)) return true;
    for (const c of this.rotulos) if (se(b, c)) return true;
    for (const [x1, y1, x2, y2] of this.segmentos) {
      const s = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      if (se(b, s)) return true;
    }
    return false;
  }

  rotular(r) {
    const claseCard = r.clase === 'rel-amb' ? 'card-amb' : 'card';
    const wc = r.card ? anchoTexto(r.card, claseCard) : 0;
    const wv = r.verbo ? anchoTexto(r.verbo, 'verb') : 0;
    const enLinea = { w: wc + (wc && wv ? 10 : 0) + wv, h: 14 };       // "1 : N  verbo"
    const apilado = { w: Math.max(wc, wv), h: r.card && r.verbo ? 30 : 14 };

    // Longitud acumulada, para preferir el centro del recorrido.
    const esq = r.esquinas;
    const largos = [];
    let total = 0;
    for (let a = 0; a < esq.length - 1; a++) {
      const l = Math.abs(esq[a + 1][0] - esq[a][0]) + Math.abs(esq[a + 1][1] - esq[a][1]);
      largos.push([total, l]); total += l;
    }

    let mejor = null;
    for (let a = 0; a < esq.length - 1; a++) {
      const [x1, y1] = esq[a], [x2, y2] = esq[a + 1];
      const [inicio, l] = largos[a];
      const horizontal = y1 === y2;
      for (let t = 10; t <= l - 10; t += 5) {
        const s = Math.sign(horizontal ? x2 - x1 : y2 - y1);
        const px = horizontal ? x1 + s * t : x1;
        const py = horizontal ? y1 : y1 + s * t;
        const candidatos = [];
        if (horizontal) {
          candidatos.push({ ...enLinea, x: px - enLinea.w / 2, y: py - 18, modo: 'linea' });
          candidatos.push({ ...enLinea, x: px - enLinea.w / 2, y: py + 5, modo: 'linea' });
          // Entre dos cajas vecinas el tramo es corto: apilado entra donde en
          // una sola linea no.
          candidatos.push({ ...apilado, x: px - apilado.w / 2, y: py - 4 - apilado.h, modo: 'pila' });
          candidatos.push({ ...apilado, x: px - apilado.w / 2, y: py + 5, modo: 'pila' });
        } else {
          candidatos.push({ ...apilado, x: px + 7, y: py - apilado.h / 2, modo: 'pila' });
          candidatos.push({ ...apilado, x: px - 7 - apilado.w, y: py - apilado.h / 2, modo: 'pila' });
          candidatos.push({ ...enLinea, x: px + 7, y: py - 7, modo: 'linea' });
          candidatos.push({ ...enLinea, x: px - 7 - enLinea.w, y: py - 7, modo: 'linea' });
        }
        for (const cand of candidatos) {
          if (this.choca(cand)) continue;
          const puntaje = Math.abs(inicio + t - total * 0.55) + (cand.modo === 'linea' && !horizontal ? 15 : 0);
          if (!mejor || puntaje < mejor.puntaje) mejor = { ...cand, puntaje };
        }
      }
    }
    if (!mejor) {
      this.avisos.push(`sin lugar para el rotulo de ${r.desde} -> ${r.hasta}`);
      return;
    }
    this.rotulos.push(mejor);

    const t = [];
    if (mejor.modo === 'linea') {
      const by = mejor.y + 11;
      if (r.card) t.push(`<text class="${claseCard}" x="${mejor.x.toFixed(0)}" y="${by.toFixed(0)}">${esc(r.card)}</text>`);
      if (r.verbo) t.push(`<text class="verb" x="${(mejor.x + wc + (wc ? 10 : 0)).toFixed(0)}" y="${by.toFixed(0)}">${esc(r.verbo)}</text>`);
    } else {
      let by = mejor.y + 11;
      if (r.card) { t.push(`<text class="${claseCard}" x="${mejor.x.toFixed(0)}" y="${by.toFixed(0)}">${esc(r.card)}</text>`); by += 16; }
      if (r.verbo) t.push(`<text class="verb" x="${mejor.x.toFixed(0)}" y="${by.toFixed(0)}">${esc(r.verbo)}</text>`);
    }
    this.textos.push(t.join('\n  '));
  }

  // ---------------------------------------------------------------------------
  // Trazos fijos (jerarquia ISA, etc.): se dibujan a mano pero se registran en
  // la grilla, para que los conectores calculados los esquiven.
  // ---------------------------------------------------------------------------
  trazoFijo(puntos, svg) {
    this.construirMapa();
    // Densifica a la grilla para marcar la ocupacion nodo por nodo.
    const nodos = [];
    for (let a = 0; a < puntos.length - 1; a++) {
      const [x1, y1] = puntos[a], [x2, y2] = puntos[a + 1];
      const pasos = (Math.abs(x2 - x1) + Math.abs(y2 - y1)) / G;
      for (let s = 0; s < pasos; s++) {
        nodos.push([x1 + Math.sign(x2 - x1) * s * G, y1 + Math.sign(y2 - y1) * s * G]);
      }
    }
    nodos.push(puntos[puntos.length - 1]);
    this.ocupar(nodos);
    for (let a = 0; a < puntos.length - 1; a++) this.segmentos.push([...puntos[a], ...puntos[a + 1]]);
    if (svg) this.trazos.push(svg);
  }

  // ---------------------------------------------------------------------------
  // Salida
  // ---------------------------------------------------------------------------
  svg(etiquetaAria) {
    return [
      `<svg class="dg" viewBox="0 0 ${this.W} ${this.H}" role="img" aria-label="${esc(etiquetaAria)}">`,
      '  <defs>',
      '    <marker id="ma" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">',
      '      <path d="M0,0 L10,5 L0,10 z" fill="var(--azul)"/>',
      '    </marker>',
      '    <marker id="mb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">',
      '      <path d="M0,0 L10,5 L0,10 z" fill="var(--ambar)"/>',
      '    </marker>',
      '  </defs>',
      ...this.fondo.map((s) => '  ' + s),
      ...this.trazos.map((s) => '  ' + s),
      ...this.cuerpo.map((s) => '  ' + s),
      ...this.textos.map((s) => '  ' + s),
      '</svg>',
    ].join('\n');
  }
}

/** Leyenda horizontal al pie de un diagrama. */
export function leyenda(lz, x, y, items) {
  lz.fondo.push(`<line class="sep" x1="${x}" y1="${y - 26}" x2="${lz.W - x}" y2="${y - 26}"/>`);
  lz.fondo.push(`<text class="zona" x="${x}" y="${y - 8}">LEYENDA</text>`);
  let cx = x;
  const s = [];
  for (const it of items) {
    const yy = y + 4;
    if (it === 'fuerte') s.push(`<rect class="ent" x="${cx}" y="${yy}" width="34" height="22"/>`);
    if (it === 'debil') s.push(`<rect class="ent-deb" x="${cx}" y="${yy}" width="34" height="22"/>`, `<rect class="ent-deb-int" x="${cx + 4}" y="${yy + 4}" width="26" height="14"/>`);
    if (it === 'asociativa') s.push(`<rect class="ent-aso" x="${cx}" y="${yy}" width="34" height="22"/>`);
    if (it === 'contexto') s.push(`<rect class="ent-ctx" x="${cx}" y="${yy}" width="34" height="22"/>`);
    if (it === 'derivado') s.push(`<text class="der" x="${cx}" y="${yy + 15}">attr</text>`);
    if (it === 'rel') s.push(`<line class="rel" x1="${cx}" y1="${yy + 11}" x2="${cx + 34}" y2="${yy + 11}" marker-end="url(#ma)"/>`);
    if (it === 'rel-amb') s.push(`<line class="rel-amb" x1="${cx}" y1="${yy + 11}" x2="${cx + 34}" y2="${yy + 11}" marker-end="url(#mb)"/>`);
    if (it === 'pk') s.push(`<text class="pk" x="${cx + 8}" y="${yy + 15}">id</text>`);
    const texto = {
      fuerte: 'Entidad fuerte', debil: 'Entidad débil', asociativa: 'Entidad asociativa',
      contexto: 'Definida en otra vista', derivado: 'Atributo derivado o calculado',
      rel: 'Relación 1:N (la flecha apunta al lado N)', 'rel-amb': 'Construcción extendida',
      pk: 'Clave primaria',
    }[it];
    s.push(`<text class="leg" x="${cx + 46}" y="${yy + 16}">${texto}</text>`);
    cx += 46 + anchoTexto(texto, 'leg') + 34;
  }
  lz.fondo.push(...s);
  lz.reservar(x, y - 40, lz.W - 2 * x, 70);
}

/** Titulo en la esquina superior izquierda. */
export function titulo(lz, principal, sub, linea) {
  lz.fondo.push(`<text class="titulo" x="40" y="48">${esc(principal)}</text>`);
  lz.fondo.push(`<text class="subtitulo" x="40" y="72">${esc(sub)}</text>`);
  if (linea) lz.fondo.push(`<text class="zona" x="40" y="96">${esc(linea)}</text>`);
  const ancho = Math.max(anchoTexto(principal, 'nom') * 2, anchoTexto(sub, 'leg') * 1.3, linea ? anchoTexto(linea, 'zona') : 0);
  lz.reservar(30, 10, Math.ceil(ancho / 10) * 10 + 30, 100);
}
