# USB JSON Protocol

The firmware wire format uses short, grouped names to keep every message below
the firmware's 100-byte JSON parser buffer.

## Commands

| Key | Meaning |
| --- | --- |
| `CM` | Control mode: 1 Manual, 2 On/Off, 3 PID |
| `SP` | Target/setpoint |
| `PW` | Primary output power |
| `A2` | Secondary output value (fan, pump, or relief output) |
| `V2` | Secondary actuator open/close command |
| `HY` | On/Off hysteresis |
| `PP`, `PI`, `PD` | PID gains |
| `PF` | PID frequency in Hz |
| `HB` | Telemetry heartbeat request |
| `IR` | Integral windup control: `1` enables anti-windup clamping; `2` disables clamping and resets the integral once. |
| `TU` | Temperature unit flag |
| `PU` | Pressure unit flag |
| `SF` | Sensor scale factor |
| `HW` | Hardware ID assignment |
| `RQ` | Request hardware ID |
| `ZS` | Zero sensor |

Example:

```json
{"CM":3,"SP":15,"PW":50,"A2":0,"HY":1}
```

## Telemetry

Main telemetry uses `SV`, `PW`, `A2`, and `UN` for sensor value, primary
output, secondary output, and unit flag. PID telemetry uses `PP`, `PI`, `PD`,
and `PO` for proportional, integral, derivative, and total output.
