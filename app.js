const express = require('express');
const jsmodbus = require('jsmodbus');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const net = require('net');
const cors = require('cors');
const sensors = require('./addresses');
const axios = require('axios');

const app = express();
const port = 3001;

const results = [];

const socket = new net.Socket();
const client = new jsmodbus.client.TCP(socket, 1); 
const options = {
  'host': '192.168.90.235', 
  'port': 502
};

app.use(cors());

function connectModbus() {
  return new Promise((resolve, reject) => {
    socket.connect(options, resolve);
    socket.on('error', reject);
  });
}

const configPath = path.join(__dirname, 'config', 'time.json');
let config;

try {
  const data = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(data);
} catch (err) {
  console.error('Error leyendo el archivo de configuración:', err);
  process.exit(1);
}

const alarmStates = {};
sensors.forEach(sensor => {
  const alarmTime = config[sensor.sensorId] || 0;
  alarmStates[sensor.sensorId] = { remainingTime: alarmTime * 60, alert: false, startTime: null }; // Convertimos minutos a segundos
});

// Función para convertir registros Modbus a float
function registersToFloat(registers) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(registers[0], 0);
  buffer.writeUInt16BE(registers[1], 2);
  return buffer.readFloatBE(0);
}

function floatToRegisters(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatBE(value, 0);
  return [buffer.readUInt16BE(0), buffer.readUInt16BE(2)];
}

function sendResults() {
  axios.post('http://10.0.0.124:4000/temperatura', results)
    .then(response => {
      console.log('Datos enviados correctamente');
    })
    .catch(error => {
      console.error('Error al enviar los datos:', error);
    });
}
// Función para leer los datos del PLC y armar el JSON
async function initialReadingSensors() {
  for (let sensor of sensors) {
    try {
      // Leer registros TEMP, HIGH y LOW del PLC
      const tempRegs = await client.readHoldingRegisters(sensor.tempAddr, 2);
      const highRegs = await client.readHoldingRegisters(sensor.highAddr, 2);
      const lowRegs = await client.readHoldingRegisters(sensor.lowAddr, 2);

      const temp = registersToFloat(tempRegs.response._body._values);
      const high = registersToFloat(highRegs.response._body._values);
      const low = registersToFloat(lowRegs.response._body._values);

      const time = config[sensor.sensorId] || 0;
      // Crear el objeto del sensor
      results.push({
        nombre: sensor.nombre,
        sensorId: sensor.sensorId,
        temp: temp.toFixed(2),
        high: high.toFixed(2),
        low: low.toFixed(2),
        alert: false,
        time: time * 60
      });
    } catch (err) {
      console.error(`Error leyendo los datos del PLC para el sensor ${sensor.sensorId}:`, err);
    }
  }
}


async function readSensors() {
  const currentTime = Date.now() / 1000; // Convertir a segundos

  for (let sensor of sensors) {
    try {
      // Leer registro TEMP del PLC
      const tempRegs = await client.readHoldingRegisters(sensor.tempAddr, 2);
      const temp = registersToFloat(tempRegs.response._body._values);

      const sensorIndex = results.findIndex(result => result.sensorId === sensor.sensorId);

      if (sensorIndex !== -1) {
        // Actualizar el valor de temp
        results[sensorIndex].temp = temp.toFixed(2);

        // Obtener umbrales y tiempos del sensor
        const { high, low } = results[sensorIndex];
        const highThreshold = parseFloat(high);
        const lowThreshold = parseFloat(low);

        // Verificar si la temperatura excede los umbrales
        const isExceeded = (temp > highThreshold || temp < lowThreshold);

        if (isExceeded) {
          // Si excede, iniciar o continuar el contador
          if (!alarmStates[sensor.sensorId].startTime) {
            alarmStates[sensor.sensorId].startTime = currentTime;
          }
          const elapsedTime = currentTime - alarmStates[sensor.sensorId].startTime;

          if (elapsedTime >= alarmStates[sensor.sensorId].remainingTime) {
            results[sensorIndex].alert = true;
            results[sensorIndex].time = 0;
          } else {
            results[sensorIndex].time = Math.round(alarmStates[sensor.sensorId].remainingTime - elapsedTime);
          }
        } else {
          // Si no excede, resetear el contador y la alarma
          results[sensorIndex].alert = false;
          results[sensorIndex].time = alarmStates[sensor.sensorId].remainingTime;
          alarmStates[sensor.sensorId].startTime = null;
        }
      }
    } catch (err) {
      console.error(`Error leyendo los datos del PLC para el sensor ${sensor.sensorId}:`, err);
    }
  }
}

async function updateSensorThreshold(sensorId, thresholdType, value) {
  const sensor = sensors.find(s => s.sensorId === sensorId);
  if (!sensor) {
    throw new Error(`Sensor with ID ${sensorId} not found`);
  }

  const registers = floatToRegisters(value);
  const address = thresholdType === 'high' ? sensor.highAddr : sensor.lowAddr;

  await client.writeRegisters(address, registers);

  const resultIndex = results.findIndex(r => r.sensorId === sensorId);
  if (resultIndex !== -1) {
    results[resultIndex][thresholdType] = value.toFixed(2);
  }
}

async function updateSensorTime(sensorId, time) {
  const configPath = path.join(__dirname, 'config', 'time.json');
  config[sensorId] = time;

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    throw new Error('Error writing to config file');
  }

  const resultIndex = results.findIndex(r => r.sensorId === sensorId);
  if (resultIndex !== -1) {
    results[resultIndex].time = time * 60;
  }

  if (alarmStates[sensorId]) {
    alarmStates[sensorId].remainingTime = time * 60;
  }
}

async function startServer() {
  await connectModbus(); 
  await initialReadingSensors(); // Espera a que se complete la lectura inicial

  const wss = new WebSocket.Server({ port: 8080 });
  setInterval(sendResults, 60000);
  setInterval(async () => {
    await readSensors();
    //console.log(results)
  }, 1000);

  app.put('/sensors/:sensorId/high', async (req, res) => {
    const { sensorId } = req.params;
    const { high } = req.body;

    if (typeof high !== 'number') {
      return res.status(400).json({ error: 'Invalid high value' });
    }

    try {
      await updateSensorThreshold(sensorId, 'high', high);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/sensors/:sensorId/low', async (req, res) => {
    const { sensorId } = req.params;
    const { low } = req.body;

    if (typeof low !== 'number') {
      return res.status(400).json({ error: 'Invalid low value' });
    }

    try {
      await updateSensorThreshold(sensorId, 'low', low);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/sensors/:sensorId/time', async (req, res) => {
    const { sensorId } = req.params;
    const { time } = req.body;

    if (typeof time !== 'number') {
      return res.status(400).json({ error: 'Invalid time value' });
    }

    try {
      await updateSensorTime(sensorId, time);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });



  wss.on('connection', (ws) => {
    console.log('Cliente conectado');

    setInterval(async () => {
      //await readSensors();
      ws.send(JSON.stringify(results));
    }, 1000);
  });

  // Iniciar el servidor HTTP
  app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
  });

  socket.on('error', (err) => {
    console.error('Error de conexión Modbus:', err);
  });
}

startServer();