# homebridge-nuki-mqtt-events

Momentary HomeKit switches that turn **on for ~1 second** whenever a Nuki Smart Lock is opened from the Keypad 2 by **fingerprint** or **code**, using the Nuki local MQTT API (`nuki/<ID>/lockActionEvent`).

Typical use: an Apple Home automation *"When Nuki Fingerprint turns on → set Security System to Off"* — so the alarm is disarmed only by fingerprint/code, never when the door is opened from inside or from the app.

## Fully standalone (v1.1+)
The plugin includes its own **built-in MQTT broker**. No Home Assistant, Mosquitto or other script is needed:

1. In the Nuki app: *Features & Configuration → Smart Home → MQTT* → Host = the IP of your Homebridge server, plus the username/password you set in the plugin.
2. That's it — the switch reacts directly.

Home Assistant can still use the lock: point Home Assistant's MQTT integration at the Homebridge server's IP (port 1883, same login). Auto-discovery keeps working, and retained messages are saved across restarts.

Prefer an existing broker? Set **MQTT broker → External** and enter its host.

## Config
```json
{
  "platform": "NukiMqttEvents",
  "brokerMode": "embedded",
  "brokerPort": 1883,
  "username": "nuki",
  "password": "********",
  "deviceId": "4E2CC127",
  "switches": [
    { "name": "Nuki Fingerprint", "sources": ["fingerprint"] },
    { "name": "Nuki Code", "sources": ["code"] }
  ]
}
```
`codeIds` limits a switch to specific people. Every event is logged with its Code ID so you can find them.

## Matter door lock with door position (v1.2, experimental)

iOS 27.2 adds **Lock After Closing** and **Door Left Open** for Matter locks that report a door position sensor. The Nuki does not report its door state over Matter, so the plugin can run its own **standalone Matter lock** (own pairing code, not bridged) with the Door Position Sensor feature:

- Lock / unlock from Home is sent to the Nuki over MQTT (`nuki/<id>/lockAction`) and confirmed by `nuki/<id>/state`. Enable lock actions in the Nuki app's MQTT settings.
- The door position comes from a HomeKit switch the plugin adds (**Door Open**). Feed it from any door sensor (e.g. Aqara) with two Home automations: sensor opens → turn the switch on; sensor closes → turn it off.
- Battery level and charging state from the Nuki (MQTT `batteryChargeState`, `batteryCharging`, `batteryCritical`) are shown on the lock in Home.
- Auto-lock uses the time set in Home (Automatic Lock), or `lockAfterCloseSeconds` if Home has none. The timer starts on any unlock (app, keypad, fingerprint, Home) and restarts when the door closes. It never locks while the door is open.

Enable it under **Matter door lock** in the plugin settings, restart, and pair it in Home with the code printed in the log (Add Accessory → More options). The plugin logs what Home writes to the lock (e.g. `autoRelockTime`).

Note: Apple may show Lock After Closing only for certain locks; this is experimental. The lock appears in Home next to the Nuki's own Matter lock.

## Keypad accessory (v1.3)

Optional (**Keypad accessory** in the settings): the keypad as its own accessory — a button that fires a single press for a fingerprint and a double press for a code, plus a battery. The Nuki only reports whether the keypad battery is low (`keypadBatteryCritical`), not a percentage, so Home shows 100% or 10% and a low-battery warning you can automate on.

## Child lock (v1.4)

Optional (**Child lock** in the settings): a switch that turns the physical button on the Smart Lock off (switch on) and back on (switch off). The Nuki MQTT API cannot change settings, so this goes through the **Nuki Web API** (cloud):

1. In the Nuki app, enable Nuki Web for the lock; in web.nuki.io enter the lock's PIN.
2. web.nuki.io → API → Generate API token, with only: View devices, View and edit devices, Manage device configuration.
3. Paste the token in the plugin settings. The lock is found automatically from the Nuki device ID.

The change reaches the lock on its next sync with Nuki (usually within a minute).

**Show as:** *inside the Matter lock* — a second lock on the Front Door accessory named after the child lock (Locked = button disabled), a separate switch, or *inside a HomeKit lock* — an extra HomeKit lock for the same door with a Lock Management service (HomeKit lock profile) carrying the child lock (`LockPhysicalControls`) and the auto-lock time (`AutoSecurityTimeout`), plus the battery and the jammed state. Experimental: whether Home shows these rows is not documented. Matter locks have no child-lock setting, so it cannot be added to the Matter lock itself.

## Event format (Nuki MQTT API v1.6)
`LockAction,Trigger,AuthID,CodeID,KeypadSource` — keypad source `1` = code, `2` = fingerprint.

## Support
If this plugin helps you: https://paypal.me/orenasher
