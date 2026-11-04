// =============================================================================
// Hash de contrasenias y PIN
//
// Se usa scrypt, que viene en Node (node:crypto). No hace falta bcrypt ni
// argon2, que son dependencias nativas: habria que compilarlas en cada maquina
// y romperian las pruebas con PGlite, que corren sin herramientas de build.
//
// POR QUE scrypt Y NO SHA-256 A SECAS:
// SHA-256 esta hecho para ser RAPIDO. Una placa de video prueba miles de
// millones por segundo, asi que un PIN de 4 digitos (10.000 combinaciones) se
// rompe antes de terminar de leer esta linea.
// scrypt esta hecho para ser LENTO y, sobre todo, para exigir MEMORIA: no se
// puede paralelizar barato en hardware dedicado. Con los parametros de abajo
// cada intento cuesta unos 100 ms y 16 MB. Para quien entra a trabajar es
// imperceptible; para quien prueba por fuerza bruta, 10.000 intentos pasan de
// ser instantaneos a tardar horas -- y el bloqueo por intentos fallidos
// (tabla intentos_login) los corta mucho antes.
// =============================================================================

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// N=16384 (coste de CPU y memoria), r=8 (tamanio de bloque), p=1 (paralelismo).
// Son los parametros que recomienda la documentacion de Node y consumen ~16 MB
// por intento. maxmem hay que subirlo a mano porque el limite por defecto de
// Node (32 MB) queda justo y scrypt falla con "memory limit exceeded".
const PARAMETROS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LARGO_CLAVE = 64;
const LARGO_SAL = 16;

/**
 * Convierte una contrasenia o PIN en su hash almacenable.
 *
 * El resultado lleva adentro la sal y los parametros usados:
 *
 *   scrypt$16384$8$1$<sal en base64>$<hash en base64>
 *
 * Guardarlos junto al hash permite subir el coste mas adelante sin invalidar
 * las contrasenias viejas: cada una se verifica con los parametros con los que
 * fue creada, y se rehashea al entrar.
 *
 * La SAL es distinta para cada usuario. Sin ella, dos empleados con el mismo
 * PIN tendrian el mismo hash -- y se podria precalcular una tabla con los
 * 10.000 PIN posibles una sola vez y leer la base entera de un vistazo.
 */
export async function hashear(textoPlano) {
  if (typeof textoPlano !== 'string' || textoPlano.length === 0) {
    throw new Error('no se puede hashear un valor vacio');
  }

  const sal = randomBytes(LARGO_SAL);
  const derivada = await scryptAsync(textoPlano, sal, LARGO_CLAVE, PARAMETROS);

  const { N, r, p } = PARAMETROS;
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64')}$${derivada.toString('base64')}`;
}

/**
 * Comprueba si el texto corresponde al hash guardado.
 *
 * Devuelve false en lugar de lanzar cuando el hash esta mal formado: en la base
 * puede haber valores de relleno de los datos de prueba, y un usuario con el
 * hash corrupto debe simplemente no poder entrar, no tumbar el servidor.
 */
export async function verificar(textoPlano, hashGuardado) {
  if (typeof textoPlano !== 'string' || typeof hashGuardado !== 'string') return false;

  const partes = hashGuardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, n, r, p, salB64, hashB64] = partes;
  const sal = Buffer.from(salB64, 'base64');
  const esperado = Buffer.from(hashB64, 'base64');
  if (sal.length === 0 || esperado.length === 0) return false;

  let derivada;
  try {
    derivada = await scryptAsync(textoPlano, sal, esperado.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMETROS.maxmem,
    });
  } catch {
    return false;  // parametros invalidos en el hash guardado
  }

  // COMPARACION EN TIEMPO CONSTANTE.
  //
  // Un === compara byte a byte y corta en cuanto encuentra una diferencia, asi
  // que tarda mas cuanto mas larga sea la parte correcta. Midiendo esa
  // diferencia de tiempo se puede ir adivinando el hash byte por byte.
  // timingSafeEqual compara siempre los mismos bytes, tarde lo que tarde.
  return timingSafeEqual(derivada, esperado);
}
