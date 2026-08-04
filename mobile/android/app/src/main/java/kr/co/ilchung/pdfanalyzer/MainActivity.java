package kr.co.ilchung.pdfanalyzer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WolPlugin.class);   // Wake-on-LAN 커스텀 플러그인
        super.onCreate(savedInstanceState);
    }
}
