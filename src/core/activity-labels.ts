import type { ActivityBody } from './activity.js';

const labels = {
  disabled: 'captura de cuerpos desactivada', empty: 'cuerpo vacío',
  binary: 'contenido binario', stream: 'respuesta en streaming',
  unavailable: 'cuerpo no disponible', read_error: 'no se pudo leer el cuerpo',
  recording_stopped: 'la grabación terminó antes de completar la lectura',
  network_limit: 'límite total de captura alcanzado',
  framework_limit: 'límite de vistas previas RSC alcanzado',
} satisfies Record<NonNullable<ActivityBody['reason']>, string>;
const reasons = new Map<string, string>(Object.entries(labels));
/** Presentation only: the recording JSON keeps its stable omission codes. */
export function activityBodyReason(reason: string | undefined): string {
  return reasons.get(reason ?? '') ?? 'no disponible';
}
