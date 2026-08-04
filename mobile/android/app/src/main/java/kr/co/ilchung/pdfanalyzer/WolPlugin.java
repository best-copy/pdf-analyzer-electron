package kr.co.ilchung.pdfanalyzer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

/**
 * Wake-on-LAN — 사무실 PC를 매직 패킷(UDP 브로드캐스트 포트 9)으로 깨운다.
 * 매직 패킷 = 0xFF x6 + 대상 MAC x16. 신뢰성 위해 3회 전송.
 * (PC 쪽은 BIOS·랜카드에서 Wake on Magic Packet이 켜져 있어야 함)
 */
@CapacitorPlugin(name = "WolPlugin")
public class WolPlugin extends Plugin {

    @PluginMethod
    public void wake(PluginCall call) {
        String mac = call.getString("mac", "");
        final byte[] macBytes = parseMac(mac);
        if (macBytes == null) {
            call.reject("MAC 주소 형식이 올바르지 않습니다: " + mac);
            return;
        }
        // 네트워크 작업은 메인 스레드 금지 (NetworkOnMainThreadException)
        new Thread(() -> {
            try {
                byte[] packet = new byte[6 + 16 * 6];
                for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
                for (int i = 0; i < 16; i++)
                    System.arraycopy(macBytes, 0, packet, 6 + i * 6, 6);

                try (DatagramSocket socket = new DatagramSocket()) {
                    socket.setBroadcast(true);
                    InetAddress bcast = InetAddress.getByName("255.255.255.255");
                    for (int i = 0; i < 3; i++) {
                        socket.send(new DatagramPacket(packet, packet.length, bcast, 9));
                        Thread.sleep(100);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("sent", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("매직 패킷 전송 실패: " + e.getMessage());
            }
        }).start();
    }

    /** "AA:BB:CC:DD:EE:FF" / "AA-BB-…" / 구분자 없는 12자리 모두 허용 */
    private static byte[] parseMac(String mac) {
        if (mac == null) return null;
        String hex = mac.replaceAll("[^0-9A-Fa-f]", "");
        if (hex.length() != 12) return null;
        byte[] out = new byte[6];
        for (int i = 0; i < 6; i++)
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
}
