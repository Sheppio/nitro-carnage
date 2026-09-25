/**
 * The real circuits (M9), in the order the menu lists them: the name, where
 * the outline comes from (`geo` from f1-circuits.json, `hand` from
 * hand.mjs), the look, and a few facts for the menu's preview line.
 */
export const CIRCUIT_INFO = {
  spa: { name: 'Circuit de Spa-Francorchamps', geo: 'spa', theme: 'park', seed: 0x5ba01, circuit: { country: 'Belgium', km: 7.004 } },
  monza: { name: 'Autodromo Nazionale Monza', geo: 'monza', theme: 'park', seed: 0x307a2, circuit: { country: 'Italy', km: 5.793 } },
  monaco: { name: 'Circuit de Monaco', geo: 'monaco', theme: 'day', harbour: true, seed: 0x30aac, circuit: { country: 'Monaco', km: 3.337 } },
  silverstone: { name: 'Silverstone Circuit', geo: 'silverstone', theme: 'park', seed: 0x51e5, circuit: { country: 'Great Britain', km: 5.891 } },
  lemans: { name: 'Circuit de la Sarthe', hand: 'lemans', theme: 'park', seed: 0x1e3a5, circuit: { country: 'France', km: 13.626 } },
  'brands-gp': { name: 'Brands Hatch', hand: 'brandsGP', theme: 'park', seed: 0xb4a9d, circuit: { country: 'Great Britain', km: 3.908 } },
  'brands-indy': { name: 'Brands Hatch (Indy)', hand: 'brandsIndy', theme: 'park', seed: 0xb4a9e, circuit: { country: 'Great Britain', km: 1.929 } },
  hockenheim: { name: 'Hockenheimring', geo: 'hockenheim', theme: 'park', seed: 0x40c4e, circuit: { country: 'Germany', km: 4.574 } },
  indianapolis: { name: 'Indianapolis Motor Speedway', hand: 'indianapolis', theme: 'park', seed: 0x1d1a5, circuit: { country: 'USA', km: 4.023 } },
  daytona: { name: 'Daytona International Speedway', hand: 'daytona', theme: 'park', lake: true, seed: 0xda707, circuit: { country: 'USA', km: 4.023 } },
  laguna: { name: 'WeatherTech Raceway Laguna Seca', hand: 'laguna', theme: 'park', seed: 0x1a6a5, circuit: { country: 'USA', km: 3.602 } },
  sebring: { name: 'Sebring International Raceway', hand: 'sebring', theme: 'park', seed: 0x5eb41, circuit: { country: 'USA', km: 6.019 } },
  'road-america': { name: 'Road America', hand: 'roadAmerica', theme: 'park', seed: 0x40ada, circuit: { country: 'USA', km: 6.515 } },
  'watkins-glen': { name: 'Watkins Glen International', geo: 'watkins', theme: 'park', seed: 0x3a761, circuit: { country: 'USA', km: 5.430 } },
  montreal: { name: 'Circuit Gilles Villeneuve', geo: 'montreal', theme: 'park', seed: 0x3071e, circuit: { country: 'Canada', km: 4.361 } },
  suzuka: { name: 'Suzuka Circuit', geo: 'suzuka', untangle: 160, theme: 'park', seed: 0x5a2a8, circuit: { country: 'Japan', km: 5.807 } },
  bathurst: { name: 'Mount Panorama Circuit', hand: 'bathurst', theme: 'park', seed: 0xba74a, circuit: { country: 'Australia', km: 6.213 } },
  interlagos: { name: 'Autódromo José Carlos Pace (Interlagos)', geo: 'interlagos', theme: 'day', seed: 0x1a7e4, circuit: { country: 'Brazil', km: 4.309 } },
  'yas-marina': { name: 'Yas Marina Circuit', geo: 'yasmarina', theme: 'dusk', harbour: true, seed: 0x9a5aa, circuit: { country: 'Abu Dhabi', km: 5.281 } },
  'red-bull-ring': { name: 'Red Bull Ring', geo: 'redbullring', theme: 'park', seed: 0x4eb41, circuit: { country: 'Austria', km: 4.318 } },
  barcelona: { name: 'Circuit de Barcelona-Catalunya', geo: 'barcelona', theme: 'park', seed: 0xba4ce, circuit: { country: 'Spain', km: 4.657 } },
};
